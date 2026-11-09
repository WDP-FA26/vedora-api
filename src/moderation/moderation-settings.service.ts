import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { ModerationSettings } from '../mongo/models.js';
import {
  type ContentPolicySettings,
  DEFAULT_CONTENT_POLICY,
} from './policies/content.js';

const SETTINGS_ID = 'content';
const CACHE_TTL_MS = 15_000;

export interface ContentSettingsInput extends ContentPolicySettings {
  rejectThreshold: number;
  reviewThreshold: number;
}

export interface ContentSettings extends ContentSettingsInput {
  version: number;
  updatedById: string | null;
  updatedAt: Date | null;
}

@Injectable()
export class ModerationSettingsService {
  private cached: { settings: ContentSettings; at: number } | null = null;

  constructor(
    @InjectModel(ModerationSettings.name)
    private readonly model: Model<ModerationSettings>,
    private readonly config: ConfigService,
  ) {}

  defaults(): ContentSettings {
    return {
      ...structuredClone(DEFAULT_CONTENT_POLICY),
      rejectThreshold: this.config.get<number>(
        'MODERATION_REJECT_THRESHOLD',
        0.85,
      ),
      reviewThreshold: this.config.get<number>(
        'MODERATION_REVIEW_THRESHOLD',
        0.3,
      ),
      version: 0,
      updatedById: null,
      updatedAt: null,
    };
  }

  async get(): Promise<ContentSettings> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.settings;
    }
    const row = await this.model.findOne({ _id: SETTINGS_ID }).exec();
    const settings = row ? this.fromRow(row) : this.defaults();
    this.cached = { settings, at: Date.now() };
    return settings;
  }

  async save(
    input: ContentSettingsInput,
    adminId: string,
    expectedVersion: number,
  ): Promise<ContentSettings> {
    const fields = {
      instructions: input.instructions,
      allowDescription: input.allowDescription,
      choices: input.choices,
      rejectThreshold: input.rejectThreshold,
      reviewThreshold: input.reviewThreshold,
      updatedById: adminId,
    };
    const saved =
      expectedVersion === 0
        ? await this.createFirst(fields)
        : await this.model
            .findOneAndUpdate(
              { _id: SETTINGS_ID, version: expectedVersion },
              { $set: fields, $inc: { version: 1 } },
              { returnDocument: 'after' },
            )
            .exec();
    if (!saved) {
      throw new StateConflictException(
        'CONFLICT',
        'The moderation settings changed since you opened them. Reload and try again',
      );
    }
    this.cached = null;
    return this.fromRow(saved);
  }

  async reset(): Promise<ContentSettings> {
    await this.model.deleteOne({ _id: SETTINGS_ID }).exec();
    this.cached = null;
    return this.get();
  }

  async reasonTexts(): Promise<Map<string, string>> {
    const { choices } = await this.get();
    return new Map(choices.map((choice) => [choice.key, choice.reasonText]));
  }

  private async createFirst(
    fields: Omit<ContentSettings, 'version' | 'updatedAt'>,
  ): Promise<ModerationSettings | null> {
    try {
      return await this.model.create({
        _id: SETTINGS_ID,
        ...fields,
        version: 1,
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  private fromRow(row: ModerationSettings): ContentSettings {
    return {
      instructions: row.instructions,
      allowDescription: row.allowDescription,
      choices: row.choices.map(({ key, label, reasonText, description }) => ({
        key,
        label,
        reasonText,
        description,
      })),
      rejectThreshold: row.rejectThreshold,
      reviewThreshold: row.reviewThreshold,
      version: row.version,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt,
    };
  }
}
