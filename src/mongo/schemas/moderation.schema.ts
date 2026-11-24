import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema({ _id: false })
export class ModerationChoice {
  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: String, required: true })
  label!: string;

  @Prop({ type: String, required: true })
  reasonText!: string;

  @Prop({ type: String, required: true })
  description!: string;
}

export const ModerationChoiceSchema =
  SchemaFactory.createForClass(ModerationChoice);

@Schema(collectionSchema('moderation_settings'))
export class ModerationSettings extends Identified {
  @Prop({ type: String })
  _id!: string;

  @Prop({ type: String, required: true })
  instructions!: string;

  @Prop({ type: String, required: true })
  allowDescription!: string;

  @Prop({ type: [ModerationChoiceSchema], required: true, default: [] })
  choices!: ModerationChoice[];

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /**
   * Set by a reset: the API serves the defaults (version 0) but keeps this
   * row, so the next save continues the version count instead of restarting
   * at 1 and a stale editor's version can no longer match.
   */
  @Prop({ type: Boolean, default: false })
  isReset?: boolean;

  @Prop({ type: String, default: null })
  updatedById!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const ModerationSettingsSchema =
  SchemaFactory.createForClass(ModerationSettings);
