import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationLimitDto } from './pagination-limit.dto.js';

export class CursorPaginationQueryDto extends PaginationLimitDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      '`nextCursor` from the previous response; omit for the first page',
  })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}
