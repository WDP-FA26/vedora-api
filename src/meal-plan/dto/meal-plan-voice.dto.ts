import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_PLANNER_MESSAGE_LENGTH } from './meal-plan.dto.js';
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
      'Send when the previous turn ended on `requestWebSearch`: `message` is then read as the spoken answer, and an approval turns web search on for this turn',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MealPlanVoiceWebSearchRequestDto)
  webSearchRequest?: MealPlanVoiceWebSearchRequestDto;

  @ApiProperty({
    maxLength: MAX_PLANNER_MESSAGE_LENGTH,
    description: 'What the user said, as transcribed by the voice model',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PLANNER_MESSAGE_LENGTH)
  message!: string;
}
