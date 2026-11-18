import { runtimeConfig } from '../config/runtime-config.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DashboardQueryDto } from '../admin-dashboard/dto/dashboard.dto.js';
import { AI_COST_FEATURES } from '../ai/telemetry/ai-cost-context.js';

export class AiCostQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({ enum: AI_COST_FEATURES })
  @IsOptional()
  @IsIn(AI_COST_FEATURES)
  feature?: string;
  @ApiPropertyOptional({
    maxLength: runtimeConfig.ADMIN_AI_COST_MODEL_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(runtimeConfig.ADMIN_AI_COST_MODEL_MAX_LENGTH)
  model?: string;
}
export class AiCostCallsQueryDto extends AiCostQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_PAGE)
  page = 1;
  @ApiPropertyOptional({
    default: runtimeConfig.AI_COST_PAGINATION_DEFAULT_LIMIT,
    maximum: runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT)
  limit = runtimeConfig.AI_COST_PAGINATION_DEFAULT_LIMIT;
}
