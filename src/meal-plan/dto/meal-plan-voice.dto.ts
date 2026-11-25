import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Weekday } from '../../mongo/models.js';
import { MAX_PLANNER_MESSAGE_LENGTH, WEEKDAYS } from './meal-plan.dto.js';
import { WeekStart } from './week-start.js';

export class MealPlanVoiceSessionDto {
  @ApiProperty({
    description:
      'Short-lived AI Gateway client secret (`vcst_…`). Open the WebSocket within its lifetime; the open session is not cut when it expires.',
  })
  token!: string;

  @ApiProperty({
    example:
      'wss://ai-gateway.vercel.sh/v4/ai/live-model?ai-model-id=openai%2Fgpt-live-1.1',
  })
  url!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Token expiry, epoch seconds',
  })
  expiresAt!: number | null;

  @ApiProperty({ example: 'openai/gpt-live-1.1' })
  model!: string;
}

export class MealPlanVoiceWebSearchRequestDto {
  @ApiProperty({
    maxLength: 100,
    description: 'The `toolCallId` of the pending `requestWebSearch` call',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  toolCallId!: string;

  @ApiProperty({
    maxLength: 200,
    description: 'Its `reason`, the question the user is answering',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason!: string;
}

/** Panels of the planner page that cover the calendar; `none` is the calendar alone. */
export const VOICE_SCREEN_PANELS = [
  'none',
  'recipe',
  'eatingLog',
  'bodyMetrics',
] as const;
export type VoiceScreenPanel = (typeof VOICE_SCREEN_PANELS)[number];

/** Parts of a recipe card the screen can be scrolled to. */
export const RECIPE_SECTIONS = ['top', 'ingredients', 'steps'] as const;
export type RecipeSection = (typeof RECIPE_SECTIONS)[number];

/** What the planner page shows while the user speaks, so the agent can refer to it. */
export class MealPlanVoiceScreenDto {
  @ApiProperty({
    example: '2026-11-23',
    description: 'Monday of the week on the calendar',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  weekStart!: string;

  @ApiPropertyOptional({
    enum: WEEKDAYS,
    description: 'The day selected on the calendar',
  })
  @IsOptional()
  @IsIn(WEEKDAYS)
  day?: Weekday;

  @ApiProperty({
    enum: VOICE_SCREEN_PANELS,
    description: 'The panel open over the calendar, `none` when there is none',
  })
  @IsIn(VOICE_SCREEN_PANELS)
  panel!: VoiceScreenPanel;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'With `panel: recipe`: the recipe shown',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  recipeId?: string;

  @ApiPropertyOptional({
    enum: RECIPE_SECTIONS,
    description:
      'With `panel: recipe`: the part the agent last scrolled the card to',
  })
  @IsOptional()
  @IsIn(RECIPE_SECTIONS)
  recipeSection?: RecipeSection;

  @ApiPropertyOptional({
    example: '2026-11-25',
    description: 'With `panel: eatingLog`: the day the diary shows',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  eatingLogDate?: string;
}

export class MealPlanVoiceTurnRequestDto {
  @WeekStart()
  weekStart!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Voice thread to continue. Leave it out on the first turn and send back the `threadId` of the previous answer.',
  })
  @IsOptional()
  @IsUUID('4')
  threadId?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Stable ID of this spoken turn (e.g. the delegation id), for quota idempotency',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  requestId?: string;

  @ApiPropertyOptional({
    type: MealPlanVoiceWebSearchRequestDto,
    description:
      'Ignored: voice turns do not search the web. Still accepted so older clients validate.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MealPlanVoiceWebSearchRequestDto)
  webSearchRequest?: MealPlanVoiceWebSearchRequestDto;

  @ApiPropertyOptional({
    type: MealPlanVoiceScreenDto,
    description:
      'What the page shows as the user speaks; the agent reads it to understand "this recipe" or "close it"',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MealPlanVoiceScreenDto)
  screen?: MealPlanVoiceScreenDto;

  @ApiProperty({
    maxLength: MAX_PLANNER_MESSAGE_LENGTH,
    description: 'What the user said, as transcribed by the voice model',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PLANNER_MESSAGE_LENGTH)
  message!: string;
}

/** What new words mean for the voice turn still running. */
export const VOICE_INTERRUPTIONS = ['progress', 'supersede', 'queue'] as const;
export type VoiceInterruption = (typeof VOICE_INTERRUPTIONS)[number];

export class MealPlanVoiceInterruptionRequestDto {
  @ApiProperty({
    maxLength: MAX_PLANNER_MESSAGE_LENGTH,
    description: 'The request the agent is still working on',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PLANNER_MESSAGE_LENGTH)
  running!: string;

  @ApiProperty({
    maxLength: MAX_PLANNER_MESSAGE_LENGTH,
    description: 'What the user said meanwhile, as transcribed',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PLANNER_MESSAGE_LENGTH)
  utterance!: string;
}

export class MealPlanVoiceInterruptionDto {
  @ApiProperty({
    enum: VOICE_INTERRUPTIONS,
    description:
      '`progress`: the user only checks on the work, keep it running; `supersede`: the user changed or stopped it, cancel it and send the new words as the next turn; `queue`: a separate request, send it after the running turn ends',
  })
  action!: VoiceInterruption;
}
