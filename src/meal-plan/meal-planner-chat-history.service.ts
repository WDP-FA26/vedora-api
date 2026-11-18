import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { UIMessage } from 'ai';
import type { Model } from 'mongoose';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
  type PaginatedResponseDto,
  type PaginationQueryDto,
} from '../common/pagination/index.js';
import { isUniqueViolation } from '../mongo/errors.js';
import {
  MealPlanChatMessage,
  type MealPlanChatProposalStatus,
  MealPlanChatThread,
} from '../mongo/models.js';
import type {
  CreateMealPlanChatThreadDto,
  MealPlanChatMessageDto,
  MealPlanChatThreadDetailDto,
  MealPlanChatThreadSummaryDto,
  PlannerMessageDto,
  UpdateMealPlanChatThreadDto,
} from './dto/meal-plan.dto.js';

export const DEFAULT_CHAT_THREAD_TITLE = 'Cuộc trò chuyện mới';
const MAX_AUTO_TITLE_LENGTH = 80;
const MAX_PREVIEW_LENGTH = 160;

function isProposalStatus(
  value: unknown,
): value is MealPlanChatProposalStatus {
  return value === 'staged' || value === 'saved' || value === 'dismissed';
}

const PROPOSAL_TOOL_TYPES: ReadonlySet<string> = new Set([
  'tool-proposeMealPlan',
  'tool-generateMealPlan',
  'tool-fillSlots',
  'tool-editDraft',
]);

export interface UpsertMealPlanChatMessageInput {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  parts?: Record<string, unknown>[];
  metadata?: { refused?: boolean } | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractTextFromParts(
  parts: readonly Record<string, unknown>[],
): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.length > 0
    ) {
      chunks.push(part.text);
    }
  }
  return chunks.join('\n\n');
}

function normalizeMessageParts(
  text: string,
  parts?: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  if (parts && parts.length > 0) {
    return parts.map((part) => ({ ...part }));
  }
  if (text.length > 0) {
    return [{ type: 'text', text }];
  }
  return [];
}

function hasRenderablePart(part: Record<string, unknown>): boolean {
  const type = part.type;
  if (typeof type !== 'string') return false;
  if (type === 'text' || type === 'reasoning') {
    return typeof part.text === 'string' && part.text.trim().length > 0;
  }
  return type.startsWith('tool-') || type === 'dynamic-tool';
}

function hasRenderableContent(
  text: string,
  parts: readonly Record<string, unknown>[],
): boolean {
  return text.trim().length > 0 || parts.some(hasRenderablePart);
}

function normalizeMetadata(
  metadata: unknown,
): { refused?: boolean } | null {
  if (!isPlainRecord(metadata)) return null;
  if (typeof metadata.refused === 'boolean') {
    return { refused: metadata.refused };
  }
  return null;
}

function deriveTitle(raw?: string): string {
  if (!raw) return DEFAULT_CHAT_THREAD_TITLE;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_CHAT_THREAD_TITLE;
  if (normalized.length <= MAX_AUTO_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_AUTO_TITLE_LENGTH - 1)}…`;
}

function derivePreview(
  text: string,
  parts: readonly Record<string, unknown>[],
): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length > 0) {
    if (normalized.length <= MAX_PREVIEW_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…`;
  }
  const hasProposal = parts.some(
    (part) => typeof part.type === 'string' && PROPOSAL_TOOL_TYPES.has(part.type),
  );
  if (hasProposal) return 'Đã tạo đề xuất thực đơn';
  const hasTool = parts.some(
    (part) =>
      typeof part.type === 'string' &&
      (part.type.startsWith('tool-') || part.type === 'dynamic-tool'),
  );
  if (hasTool) return 'Đã tra cứu thông tin';
  return null;
}

function toThreadSummary(
  thread: MealPlanChatThread,
): MealPlanChatThreadSummaryDto {
  return {
    id: thread.id,
    title: thread.title,
    messageCount: thread.messageCount,
    lastMessagePreview: thread.lastMessagePreview ?? null,
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function toMessageDto(message: MealPlanChatMessage): MealPlanChatMessageDto {
  return {
    id: message.messageId,
    role: message.role,
    text: message.text,
    parts: message.parts,
    metadata: message.metadata ?? null,
    createdAt: message.createdAt,
  };
}

function toProposalStatuses(
  raw: unknown,
): Record<string, MealPlanChatProposalStatus> {
  if (!isPlainRecord(raw)) return {};
  const result: Record<string, MealPlanChatProposalStatus> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === 'staged' ||
      value === 'saved' ||
      value === 'dismissed'
    ) {
      result[key] = value;
    }
  }
  return result;
}

@Injectable()
export class MealPlannerChatHistoryService {
  constructor(
    @InjectModel(MealPlanChatThread.name)
    private readonly threads: Model<MealPlanChatThread>,
    @InjectModel(MealPlanChatMessage.name)
    private readonly messages: Model<MealPlanChatMessage>,
  ) {}

  async assertThreadAccess(userId: string, threadId: string): Promise<void> {
    const existing = await this.threads
      .findById(threadId)
      .select('userId')
      .exec();
    if (existing && existing.userId !== userId) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Chat thread not found');
    }
  }

  async ensureThread(
    userId: string,
    threadId: string,
    initialTitle?: string,
  ): Promise<MealPlanChatThread> {
    const existing = await this.threads.findById(threadId).exec();
    if (existing) {
      if (existing.userId !== userId) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Chat thread not found',
        );
      }
      return existing;
    }

    try {
      return await this.threads.create({
        _id: threadId,
        userId,
        title: deriveTitle(initialTitle),
        sequence: 0,
        messageCount: 0,
        lastMessageAt: new Date(),
        lastMessagePreview: null,
        proposalStatuses: {},
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raceThread = await this.threads.findById(threadId).exec();
      if (!raceThread || raceThread.userId !== userId) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Chat thread not found',
        );
      }
      return raceThread;
    }
  }

  async upsertMessage(
    userId: string,
    threadId: string,
    input: UpsertMealPlanChatMessageInput,
  ): Promise<void> {
    const inputParts = input.parts ?? [];
    const text = input.text ?? extractTextFromParts(inputParts);
    const parts = normalizeMessageParts(text, inputParts);
    const metadata = normalizeMetadata(input.metadata);
    const preview = derivePreview(text, parts);
    const now = new Date();

    const existing = await this.messages
      .findOne({ threadId, messageId: input.id })
      .exec();
    if (existing) {
      if (existing.userId !== userId) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Chat thread not found',
        );
      }
      existing.text = text;
      existing.parts = parts;
      existing.metadata = metadata;
      await existing.save();

      const thread = await this.threads.findOne({ _id: threadId, userId }).exec();
      if (thread && existing.sequence === thread.sequence && preview !== null) {
        thread.lastMessagePreview = preview;
        thread.lastMessageAt = now;
        await thread.save();
      }
      return;
    }

    const thread = await this.ensureThread(
      userId,
      threadId,
      input.role === 'user' ? text : undefined,
    );
    const titleUpdate =
      thread.title === DEFAULT_CHAT_THREAD_TITLE &&
      input.role === 'user' &&
      text.trim().length > 0
        ? { title: deriveTitle(text) }
        : {};

    const updatedThread = await this.threads
      .findOneAndUpdate(
        { _id: threadId, userId },
        {
          $inc: { sequence: 1, messageCount: 1 },
          $set: {
            lastMessageAt: now,
            ...(preview !== null ? { lastMessagePreview: preview } : {}),
            ...titleUpdate,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updatedThread) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Chat thread not found');
    }

    try {
      await this.messages.create({
        threadId,
        userId,
        messageId: input.id,
        sequence: updatedThread.sequence,
        role: input.role,
        text,
        parts,
        metadata,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.threads
        .updateOne(
          { _id: threadId, userId, messageCount: { $gt: 0 } },
          { $inc: { messageCount: -1 } },
        )
        .exec();
      await this.messages
        .updateOne(
          { threadId, userId, messageId: input.id },
          { $set: { text, parts, metadata } },
        )
        .exec();
    }
  }

  async recordUserTurn(
    userId: string,
    threadId: string,
    turns: readonly PlannerMessageDto[],
    requestId?: string,
  ): Promise<void> {
    if (turns.length === 0) return;
    const thread = await this.ensureThread(userId, threadId, turns[0]?.text);

    if (thread.messageCount === 0 && turns.length > 1) {
      for (let index = 0; index < turns.length - 1; index++) {
        const turn = turns[index];
        await this.upsertMessage(userId, threadId, {
          id: `prior-${index + 1}`,
          role: turn.role,
          text: turn.text,
          parts: [{ type: 'text', text: turn.text }],
        });
      }
    }

    const latest = turns[turns.length - 1];
    await this.upsertMessage(userId, threadId, {
      id: requestId ?? randomUUID(),
      role: 'user',
      text: latest.text,
      parts: [{ type: 'text', text: latest.text }],
    });
  }

  async recordAssistantMessage(
    userId: string,
    threadId: string,
    message: UIMessage,
  ): Promise<void> {
    const parts: Record<string, unknown>[] = [];
    for (const part of message.parts) {
      if (isPlainRecord(part)) parts.push(part);
    }
    const text = extractTextFromParts(parts);
    if (!hasRenderableContent(text, parts)) return;

    await this.upsertMessage(userId, threadId, {
      id: message.id || randomUUID(),
      role: 'assistant',
      text,
      parts,
      metadata: normalizeMetadata(message.metadata),
    });
  }

  async listThreads(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<MealPlanChatThreadSummaryDto>> {
    const filter = { userId };
    const { skip, take } = getPaginationArgs(query);
    const [rows, total] = await Promise.all([
      this.threads
        .find(filter)
        .sort({ lastMessageAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.threads.countDocuments(filter).exec(),
    ]);
    return createPaginatedResponse(
      rows.map(toThreadSummary),
      total,
      query,
    );
  }

  async createThread(
    userId: string,
    dto: CreateMealPlanChatThreadDto,
  ): Promise<MealPlanChatThreadDetailDto> {
    const thread = await this.ensureThread(
      userId,
      dto.id ?? randomUUID(),
      dto.title,
    );
    return this.getThread(userId, thread.id);
  }

  async getThread(
    userId: string,
    threadId: string,
  ): Promise<MealPlanChatThreadDetailDto> {
    const thread = await this.threads.findOne({ _id: threadId, userId }).exec();
    if (!thread) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Chat thread not found');
    }
    const messageRows = await this.messages
      .find({ threadId, userId })
      .sort({ sequence: 1, _id: 1 })
      .exec();

    return {
      ...toThreadSummary(thread),
      proposalStatuses: toProposalStatuses(thread.proposalStatuses),
      messages: messageRows.map(toMessageDto),
    };
  }

  async updateThread(
    userId: string,
    threadId: string,
    dto: UpdateMealPlanChatThreadDto,
  ): Promise<MealPlanChatThreadDetailDto> {
    await this.ensureThread(userId, threadId, dto.title);

    const updates: {
      title?: string;
      proposalStatuses?: Record<string, MealPlanChatProposalStatus>;
    } = {};

    if (dto.title !== undefined) {
      const normalized = dto.title.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        updates.title = normalized;
      }
    }

    if (dto.proposalStatuses !== undefined) {
      const thread = await this.threads
        .findOne({ _id: threadId, userId })
        .exec();
      if (!thread) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Chat thread not found',
        );
      }
      const nextStatuses = toProposalStatuses(thread.proposalStatuses);
      for (const [proposalId, status] of Object.entries(dto.proposalStatuses)) {
        if (!isProposalStatus(status)) {
          throw new InvalidInputException(
            'BAD_REQUEST',
            `Invalid proposal status for ${proposalId}`,
          );
        }
        nextStatuses[proposalId] = status;
      }
      updates.proposalStatuses = nextStatuses;
    }

    if (Object.keys(updates).length > 0) {
      await this.threads
        .updateOne({ _id: threadId, userId }, { $set: updates })
        .exec();
    }

    if (dto.messages && dto.messages.length > 0) {
      for (const message of dto.messages) {
        await this.upsertMessage(userId, threadId, {
          id: message.id,
          role: message.role,
          text: message.text,
          parts: message.parts,
          metadata: message.metadata,
        });
      }
    }

    return this.getThread(userId, threadId);
  }

  async deleteThread(userId: string, threadId: string): Promise<void> {
    const deleted = await this.threads
      .findOneAndDelete({ _id: threadId, userId })
      .exec();
    if (!deleted) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Chat thread not found');
    }
    await this.messages.deleteMany({ threadId, userId }).exec();
  }
}
