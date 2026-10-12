import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostStatus, PostType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';
import {
  AdminMediaDetailDto,
  AdminMediaDto,
} from '../../media/dto/media-response.dto';
import { PostAuthorDto } from './post-response.dto';
import { BlogSummaryDto } from './blog-summary.dto';

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

export class AdminPostDetailDto extends AdminPostDto {
  @ApiProperty({ type: [AdminMediaDetailDto] })
  declare media: AdminMediaDetailDto[];
}
