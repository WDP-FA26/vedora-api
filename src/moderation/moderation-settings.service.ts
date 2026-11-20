import { runtimeConfig } from '../config/runtime-config.js';
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
  withReservedChoices,
} from './policies/content.js';
import { isEnforced } from '../config/moderation-mode.js';

const SETTINGS_ID = 'content';
const CACHE_TTL_MS = runtimeConfig.MODERATION_CACHE_TTL_MS;

export interface ContentSettingsInput extends ContentPolicySettings {
  rejectThreshold: number;
  reviewThreshold: number;
  /** Omitted: keep the saved one (or the default). */
  manipulationThreshold?: number;
}

export interface ContentSettings extends ContentSettingsInput {
  /** A `manipulation` chance at or above this is rejected outright. */
  manipulationThreshold: number;
  /** Whether that rule is applied now (MODERATION_MODE=enforce) or only recorded. */
  manipulationEnforced: boolean;
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

  private defaultManipulationThreshold(): number {
    return this.config.get<number>('MODERATION_MANIPULATION_THRESHOLD', 0.5);
  }

  defaults(): ContentSettings {
    const policy = structuredClone(DEFAULT_CONTENT_POLICY);
    return {
      ...policy,
      choices: withReservedChoices(policy.choices),
      manipulationThreshold: this.defaultManipulationThreshold(),
      manipulationEnforced: isEnforced(this.config),
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
    const settings = row && !row.isReset ? this.fromRow(row) : this.defaults();
    this.cached = { settings, at: Date.now() };
    return settings;
  }

  async save(
    input: ContentSettingsInput,
    adminId: string,
    expectedVersion: number,
  ): Promise<ContentSettings> {
    const manipulationThreshold =
      input.manipulationThreshold ?? (await this.get()).manipulationThreshold;
    const fields = {
      instructions: input.instructions,
      allowDescription: input.allowDescription,
      choices: withReservedChoices(input.choices),
      rejectThreshold: input.rejectThreshold,
      reviewThreshold: input.reviewThreshold,
      manipulationThreshold,
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

  /**
   * A save made from the defaults (version 0): the very first one creates
   * the row; after a reset it reuses the row and continues its version.
   */
  private async saveOverDefaults(
    fields: Omit<
      ContentSettings,
      'version' | 'updatedAt' | 'manipulationEnforced'
    >,
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
    fields: Omit<
      ContentSettings,
      'version' | 'updatedAt' | 'manipulationEnforced'
    >,
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
      rejectThreshold: row.rejectThreshold,
      reviewThreshold: row.reviewThreshold,
      manipulationThreshold:
        row.manipulationThreshold ?? this.defaultManipulationThreshold(),
      manipulationEnforced: isEnforced(this.config),
      version: row.version,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt,
    };
  }
}
