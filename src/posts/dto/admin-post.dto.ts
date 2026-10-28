import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostStatus, PostType } from '../../mongo/models.js';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/index.js';
import { AdminMediaDto } from '../../media/dto/media-response.dto.js';
import { PostAuthorDto } from './post-response.dto.js';
import { BlogSummaryDto } from './blog-summary.dto.js';

export class AdminPostsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PostStatus })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;
}

export class AdminPostDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PostType }) type!: PostType;
  @ApiProperty({ enum: PostStatus }) status!: PostStatus;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({ nullable: true, type: BlogSummaryDto })
  blog!: BlogSummaryDto | null;
  @ApiProperty({ nullable: true, type: Date }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
  @ApiProperty({ type: [AdminMediaDto] }) media!: AdminMediaDto[];
  @ApiProperty({ minimum: 0 }) commentCount!: number;
  @ApiProperty({ minimum: 0 }) likeCount!: number;
  @ApiProperty({ minimum: 0 }) repostCount!: number;
  @ApiProperty({ minimum: 0 }) viewCount!: number;
}
