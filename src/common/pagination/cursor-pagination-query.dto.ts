import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationLimitDto } from './pagination-limit.dto';

/** UUID cursor for collections whose primary key is a UUID v4, such as posts. */
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
