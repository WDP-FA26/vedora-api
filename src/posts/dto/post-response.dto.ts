import { ApiProperty } from '@nestjs/swagger';
import { PostStatus, PostType } from '@prisma/client';
import { CursorPaginatedResponseDto } from '../../common/pagination';
import { MediaResponseDto } from '../../media/dto/media-response.dto';
import { BlogSummaryDto } from './blog-summary.dto';

export class PostAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'vedora.user' })
  username!: string;

  @ApiProperty({ example: 'Vedora User' })
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;
}

export class PostResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PostType })
  type!: PostType;

  @ApiProperty({
    enum: PostStatus,
    description:
      'Blogs start DRAFT; videos start PROCESSING. Only the author sees non-PUBLISHED posts',
  })
  status!: PostStatus;

  @ApiProperty({ nullable: true, type: String })
  body!: string | null;

  @ApiProperty({ nullable: true, type: BlogSummaryDto })
  blog!: BlogSummaryDto | null;

  @ApiProperty({ nullable: true, type: Date })
  publishedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: PostAuthorDto })
  author!: PostAuthorDto;

  @ApiProperty({ type: [MediaResponseDto] })
  media!: MediaResponseDto[];

  @ApiProperty({ minimum: 0 })
  commentCount!: number;

  @ApiProperty({ minimum: 0 })
  likeCount!: number;

  @ApiProperty({
    description:
      'Whether the authenticated viewer likes this post; false for anonymous reads',
  })
  isLiked!: boolean;

  @ApiProperty({ minimum: 0 })
  repostCount!: number;

  @ApiProperty({
    description:
      'Whether the authenticated viewer reposted this post; false for anonymous reads',
  })
  isReposted!: boolean;

  @ApiProperty({
    description:
      'Whether the authenticated viewer saved this post; false for anonymous reads',
  })
  isBookmarked!: boolean;

  @ApiProperty({
    minimum: 0,
    description: 'Times the post was on screen; a few seconds behind',
  })
  viewCount!: number;
}

export class PostPageDto extends CursorPaginatedResponseDto<PostResponseDto> {
  @ApiProperty({ type: [PostResponseDto] })
  declare items: PostResponseDto[];
}
