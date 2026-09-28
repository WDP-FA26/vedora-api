import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { CursorPaginationQueryDto } from '../../common/pagination';

export class ListPostsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this author' })
  @IsOptional()
  @IsUUID('4')
  authorId?: string;
}
