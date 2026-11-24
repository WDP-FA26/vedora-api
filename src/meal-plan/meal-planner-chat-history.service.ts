import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { UIMessage } from 'ai';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { runtimeConfig } from '../config/runtime-config.js';
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
  MealSection,
  Weekday,
} from '../mongo/models.js';
import type {
  CreateMealPlanChatThreadDto,
  MealPlanChatMessageDto,
  MealPlanChatRewindDto,
  MealPlanChatRewindWeekDto,
  MealPlanChatThreadDetailDto,
  MealPlanChatThreadSummaryDto,
  PlannerToolOutputDto,
  SaveMealDayDto,
  UpdateMealPlanChatThreadDto,
} from './dto/meal-plan.dto.js';
import { MealPlanService } from './meal-plan.service.js';

export const DEFAULT_CHAT_THREAD_TITLE = 'Cuộc trò chuyện mới';
const MAX_AUTO_TITLE_LENGTH = 80;
const MAX_PREVIEW_LENGTH = 160;

/**
 * A stored chat message as the model will see it. It is not validated here:
 * the chat service validates the whole history against the current tools.
 */
export type StoredChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Record<string, unknown>[];
  metadata?: { refused?: boolean };
};

const askUserOutputSchema = z.object({
  answer: z
    .string()
    .trim()
    .min(1)
    .max(runtimeConfig.PLANNER_CHAT_MAX_MESSAGE_LENGTH),
});
const webSearchDecisionSchema = z.object({
  approved: z.boolean(),
});

/** Validates a client-supplied answer for `askUser` or `requestWebSearch`. */
export function validatePlannerToolOutput(
  toolOutput: PlannerToolOutputDto,
): { answer: string } | { approved: boolean } {
  const schema =
    toolOutput.tool === 'askUser'
      ? askUserOutputSchema
      : webSearchDecisionSchema;
  const parsed = schema.safeParse(toolOutput.output);
  if (!parsed.success) {
    throw new InvalidInputException(
      'BAD_REQUEST',
      'Invalid planner tool output',
    );
  }
  return parsed.data;
}

function isProposalStatus(value: unknown): value is MealPlanChatProposalStatus {
  return value === 'staged' || value === 'saved' || value === 'dismissed';
}

/** The planner's tools that write the saved plan; each output is a `PlanChange`. */
const PLAN_CHANGE_TOOL_TYPES: ReadonlySet<string> = new Set([
  'tool-fillSlots',
  'tool-autoBalancePlan',
  'tool-editPlan',
  'tool-verifyMealPlanAllergies',
]);

const recipeRefSchema = z.object({ id: z.string() });
/**
 * The part of a saved `PlanChange` a rewind needs. Outputs of the draft era
 * have no `applied` and were never saved, so they do not parse.
 */
const savedChangeSchema = z.object({
  applied: z.literal(true),
  weekStart: z.string(),
  days: z.array(
    z.object({
      day: z.enum(Weekday),
      sections: z.array(
        z.object({
          section: z.enum(MealSection),
          previous: z.array(recipeRefSchema),
        }),
      ),
    }),
  ),
});

/**
 * The days the assistant changed in `parts`, as they were before its first
 * change, by week. A later change to the same day is ignored: the first
 * change's `previous` already holds the day before the turn.
 */
/** How far back the voice agent's undo looks for a reply that changed the plan. */
const UNDO_LOOKBACK_MESSAGES = 50;

function daysBeforeChanges(
  messages: readonly MealPlanChatMessage[],
): Map<string, SaveMealDayDto[]> {
  const byWeek = new Map<string, SaveMealDayDto[]>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (typeof part.type !== 'string') continue;
      if (!PLAN_CHANGE_TOOL_TYPES.has(part.type)) continue;
      if (part.state !== 'output-available') continue;
      const change = savedChangeSchema.safeParse(part.output);
      if (!change.success) continue;
      const days = byWeek.get(change.data.weekStart) ?? [];
      for (const { day, sections } of change.data.days) {
        if (days.some((item) => item.day === day)) continue;
        const ids = (section: MealSection): string[] => {
          const found = sections.find((item) => item.section === section);
          return found ? found.previous.map(({ id }) => id) : [];
        };
        days.push({
          day,
          breakfast: ids(MealSection.BREAKFAST),
          lunch: ids(MealSection.LUNCH),
          dinner: ids(MealSection.DINNER),
          others: ids(MealSection.OTHER),
        });
      }
      byWeek.set(change.data.weekStart, days);
    }
  }
  return byWeek;
}

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

function normalizeMetadata(metadata: unknown): { refused?: boolean } | null {
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
  const changedPlan = parts.some(
    (part) =>
      typeof part.type === 'string' && PLAN_CHANGE_TOOL_TYPES.has(part.type),
  );
  if (changedPlan) return 'Đã cập nhật thực đơn';
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
    if (value === 'staged' || value === 'saved' || value === 'dismissed') {
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
    private readonly mealPlan: MealPlanService,
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

      const thread = await this.threads
        .findOne({ _id: threadId, userId })
        .exec();
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

  /**
   * Attaches a client-side tool output (`askUser` or `requestWebSearch`) to the
   * stored assistant message part matching `toolCallId`.
   */
  async recordToolOutput(
    userId: string,
    threadId: string,
    toolOutput: PlannerToolOutputDto,
  ): Promise<void> {
    const validated = validatePlannerToolOutput(toolOutput);
    const existing = await this.messages
      .findOne({
        threadId,
        userId,
        role: 'assistant',
        'parts.toolCallId': toolOutput.toolCallId,
      })
      .exec();
    if (!existing) return;

    const targetType = `tool-${toolOutput.tool}`;
    let changed = false;
    const updatedParts: Record<string, unknown>[] = [];
    for (const part of existing.parts) {
      if (
        part.type === targetType &&
        part.toolCallId === toolOutput.toolCallId
      ) {
        updatedParts.push({
          ...part,
          state: 'output-available',
          output: validated,
        });
        changed = true;
      } else {
        updatedParts.push(part);
      }
    }
    if (!changed) return;

    existing.parts = updatedParts;
    existing.markModified('parts');
    await existing.save();
  }

  /** Persists a single user message for the current turn. */
  async recordUserMessage(
    userId: string,
    threadId: string,
    text: string,
    requestId?: string,
  ): Promise<void> {
    await this.upsertMessage(userId, threadId, {
      id: requestId ?? randomUUID(),
      role: 'user',
      text,
      parts: [{ type: 'text', text }],
    });
  }

  /**
   * Loads recent non-refused turns for `threadId` in chronological order, as
   * stored. Validate them with `validateUIMessages` before use.
   */
  async loadContextMessages(
    userId: string,
    threadId: string,
    limit = runtimeConfig.PLANNER_CHAT_MAX_MESSAGES,
  ): Promise<StoredChatMessage[]> {
    const fetchLimit = Math.max(limit * 2, 80);
    const recentDesc = await this.messages
      .find({ threadId, userId })
      .sort({ sequence: -1, _id: -1 })
      .limit(fetchLimit)
      .exec();
    const chronological = recentDesc.reverse();

    const nonRefused: MealPlanChatMessage[] = [];
    for (let index = 0; index < chronological.length; index++) {
      const current = chronological[index];
      const next = chronological[index + 1];
      if (current.metadata?.refused) continue;
      if (
        current.role === 'user' &&
        next?.role === 'assistant' &&
        next.metadata?.refused
      ) {
        continue;
      }
      nonRefused.push(current);
    }

    const window = nonRefused.slice(-limit);
    const stored: StoredChatMessage[] = [];
    for (const row of window) {
      const message: StoredChatMessage = {
        id: row.messageId,
        role: row.role,
        parts: normalizeMessageParts(row.text, row.parts),
      };
      if (row.metadata) {
        message.metadata = row.metadata;
      }
      stored.push(message);
    }
    return stored;
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
    return createPaginatedResponse(rows.map(toThreadSummary), total, query);
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

  /**
   * Goes back to just before the user's message `messageId`, like a rewind:
   * the days the assistant changed from that turn on get their dishes back,
   * and that message and everything after it leave the thread. Days that have
   * passed since cannot change and are reported in `skipped`.
   */
  async rewind(
    userId: string,
    threadId: string,
    messageId: string,
  ): Promise<MealPlanChatRewindDto> {
    const target = await this.messages
      .findOne({ threadId, userId, messageId })
      .exec();
    if (!target || target.role !== 'user') {
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Chat message not found',
      );
    }
    const later = await this.messages
      .find({ threadId, userId, sequence: { $gte: target.sequence } })
      .sort({ sequence: 1, _id: 1 })
      .exec();

    const restored: MealPlanChatRewindWeekDto[] = [];
    for (const [weekStart, days] of daysBeforeChanges(later)) {
      const result = await this.mealPlan.restoreDays(userId, weekStart, days);
      restored.push({ weekStart, ...result });
    }

    await this.messages
      .deleteMany({ threadId, userId, sequence: { $gte: target.sequence } })
      .exec();
    const last = await this.messages
      .findOne({ threadId, userId })
      .sort({ sequence: -1, _id: -1 })
      .exec();
    const remaining = await this.messages
      .countDocuments({ threadId, userId })
      .exec();
    await this.threads
      .updateOne(
        { _id: threadId, userId },
        {
          $set: {
            messageCount: remaining,
            lastMessagePreview: last
              ? derivePreview(last.text, last.parts)
              : null,
          },
        },
      )
      .exec();
    return { text: target.text, weeks: restored };
  }

  /**
   * Puts back the dishes changed by the newest assistant message of the thread
   * that changed the plan and was not undone yet, keeping every message: the
   * voice agent's "undo". The undo itself is recorded as an `undoLastChange`
   * tool output on the current reply, which is how the next undo skips it.
   */
  async undoLatestChange(
    userId: string,
    threadId: string,
  ): Promise<{ messageId: string | null; weeks: MealPlanChatRewindWeekDto[] }> {
    const replies = await this.messages
      .find({ threadId, userId, role: 'assistant' })
      .sort({ sequence: -1, _id: -1 })
      .limit(UNDO_LOOKBACK_MESSAGES)
      .exec();
    const undone = new Set<string>();
    for (const reply of replies) {
      for (const part of reply.parts) {
        if (part.type !== 'tool-undoLastChange') continue;
        if (part.state !== 'output-available') continue;
        const output = part.output;
        if (isPlainRecord(output) && typeof output.messageId === 'string') {
          undone.add(output.messageId);
        }
      }
    }
    const target = replies.find(
      (reply) =>
        !undone.has(reply.messageId) && daysBeforeChanges([reply]).size > 0,
    );
    if (!target) return { messageId: null, weeks: [] };

    const weeks: MealPlanChatRewindWeekDto[] = [];
    for (const [weekStart, days] of daysBeforeChanges([target])) {
      const result = await this.mealPlan.restoreDays(userId, weekStart, days);
      weeks.push({ weekStart, ...result });
    }
    return { messageId: target.messageId, weeks };
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
