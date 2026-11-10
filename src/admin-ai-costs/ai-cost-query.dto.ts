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
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;
}
export class AiCostCallsQueryDto extends AiCostQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;
  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
