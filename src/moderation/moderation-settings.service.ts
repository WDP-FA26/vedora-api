import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { ModerationSettings } from '../mongo/models.js';
import {
  type ContentPolicySettings,
  DEFAULT_CONTENT_POLICY,
  withReservedChoices,
} from './policies/content.js';

const SETTINGS_ID = 'content';
const CACHE_TTL_MS = runtimeConfig.MODERATION_CACHE_TTL_MS;

export interface ContentSettings extends ContentPolicySettings {
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
  ) {}

  defaults(): ContentSettings {
    const policy = structuredClone(DEFAULT_CONTENT_POLICY);
    return {
      ...policy,
      choices: withReservedChoices(policy.choices),
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
    const settings = row && !row.isReset ? this.fromRow(row) : this.defaults();
    this.cached = { settings, at: Date.now() };
    return settings;
  }

  async save(
    input: ContentPolicySettings,
    adminId: string,
    expectedVersion: number,
  ): Promise<ContentSettings> {
    const fields = {
      instructions: input.instructions,
      allowDescription: input.allowDescription,
      choices: withReservedChoices(input.choices),
      updatedById: adminId,
    };
    const saved =
      expectedVersion === 0
        ? await this.saveOverDefaults(fields)
        : await this.model
            .findOneAndUpdate(
              {
                _id: SETTINGS_ID,
                version: expectedVersion,
                isReset: { $ne: true },
              },
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
    await this.model
      .updateOne({ _id: SETTINGS_ID }, { $set: { isReset: true } })
      .exec();
    this.cached = null;
    return this.get();
  }

  async reasonTexts(): Promise<Map<string, string>> {
    const { choices } = await this.get();
    return new Map(choices.map((choice) => [choice.key, choice.reasonText]));
  }

  private async saveOverDefaults(
    fields: Omit<ContentSettings, 'version' | 'updatedAt'>,
  ): Promise<ModerationSettings | null> {
    const afterReset = await this.model
      .findOneAndUpdate(
        { _id: SETTINGS_ID, isReset: true },
        { $set: { ...fields, isReset: false }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .exec();
    if (afterReset) return afterReset;
    return this.createFirst(fields);
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
    const choices = row.choices.map(
      ({ key, label, reasonText, description }) => ({
        key,
        label,
        reasonText,
        description,
      }),
    );
    return {
      instructions: row.instructions,
      allowDescription: row.allowDescription,
      choices: withReservedChoices(choices),
      version: row.version,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt,
    };
  }
}
