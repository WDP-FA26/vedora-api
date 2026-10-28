import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaginationLimitDto } from './pagination-limit.dto.js';

// Keeps calculated skip values sane before they reach MongoDB.
export const MAX_PAGE_NUMBER = 1_000_000;

/** Extend this DTO with a collection's filters, never with user-provided skip. */
export class PaginationQueryDto extends PaginationLimitDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_NUMBER,
    default: 1,
    description: 'Page number, starting at 1',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page: number = 1;
}
