import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/index.js';
import { runtimeConfig } from '../config/runtime-config.js';
import {
  SYSTEM_LOG_OUTCOMES,
  SYSTEM_LOG_RESOURCES,
  type SystemLogOutcome,
  type SystemLogResource,
} from '../mongo/models.js';

export class SystemLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: runtimeConfig.SYSTEM_LOG_QUERY_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(runtimeConfig.SYSTEM_LOG_QUERY_MAX_LENGTH)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;
  @ApiPropertyOptional({ enum: SYSTEM_LOG_OUTCOMES })
  @IsOptional()
  @IsIn(SYSTEM_LOG_OUTCOMES)
  outcome?: SystemLogOutcome;
  @ApiPropertyOptional({ enum: SYSTEM_LOG_RESOURCES })
  @IsOptional()
  @IsIn(SYSTEM_LOG_RESOURCES)
  resourceType?: SystemLogResource;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  requestId?: string;
  @ApiPropertyOptional({ description: 'Inclusive ISO timestamp with timezone' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/)
  from?: string;
  @ApiPropertyOptional({ description: 'Inclusive ISO timestamp with timezone' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/)
  to?: string;
}

export class SystemLogDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty() actorUsername!: string;
  @ApiProperty() action!: string;
  @ApiProperty() actionLabel!: string;
  @ApiProperty({ enum: SYSTEM_LOG_RESOURCES }) resourceType!: SystemLogResource;
  @ApiProperty({ type: String, nullable: true }) targetId!: string | null;
  @ApiProperty() method!: string;
  @ApiProperty() route!: string;
  @ApiProperty({ enum: SYSTEM_LOG_OUTCOMES }) outcome!: SystemLogOutcome;
  @ApiProperty() httpStatus!: number;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty() durationMs!: number;
  @ApiProperty({ type: String, nullable: true }) decision!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetRole!: string | null;
  @ApiProperty() createdAt!: Date;
}
