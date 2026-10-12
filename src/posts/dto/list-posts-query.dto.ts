import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PostType } from '@prisma/client';
import { CursorPaginationQueryDto } from '../../common/pagination';

export class ListPostsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    enum: PostType,
    description: 'POST videos/text or BLOG articles',
  })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this author' })
  @IsOptional()
  @IsUUID('4')
  authorId?: string;
}
