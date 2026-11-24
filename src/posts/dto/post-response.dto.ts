import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EVIDENCE_FIELDS,
  type EvidenceField,
  PostStatus,
  PostType,
} from '../../mongo/models.js';
import { CursorPaginatedResponseDto } from '../../common/pagination/index.js';
import { MediaResponseDto } from '../../media/dto/media-response.dto.js';
import { PostAuthorDto } from '../../common/dto/post-author.dto.js';
import { PostAppealSummaryDto } from '../../support/dto/post-appeal-summary.dto.js';
import { BlogSummaryDto } from './blog-summary.dto.js';

/** One part of a rejected post that broke the policy, as the author sees it. */
export class ModerationFindingDto {
  @ApiProperty({
    enum: EVIDENCE_FIELDS,
    description:
      'Where the part is: body (post text), title/content (blog), transcript (speech in a video), frame (a video frame) or image',
  })
  field!: EvidenceField;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Text fields: the exact words. Frames and images: text read in the picture, or null',
  })
  quote!: string | null;

  @ApiProperty({
    description: 'Why this part breaks the policy, one sentence in Vietnamese',
  })
  reason!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      '`reasonText` of the category this part fits, from the current policy; null if the category no longer exists',
  })
  reasonText!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The video the transcript or frame belongs to',
  })
  mediaId!: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Frames: second of the video the frame is from',
  })
  seconds!: number | null;
}

export class PostResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PostType })
  type!: PostType;

  @ApiProperty({
    enum: PostStatus,
    description:
      'Blogs start DRAFT; posts and published blogs are PROCESSING until video and content moderation finish, then PUBLISHED or REJECTED. Only the author sees non-PUBLISHED posts',
  })
  status!: PostStatus;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Why a REJECTED post was blocked: sexual, violence, hate, harassment, self_harm, illegal or spam. Null otherwise',
  })
  moderationVerdict!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      '`moderationVerdict` worded for the author, e.g. "bạo lực hoặc đe dọa". Null if the category no longer exists',
  })
  moderationReason!: string | null;

  @ApiProperty({
    type: [ModerationFindingDto],
    description:
      'The parts of a REJECTED post that broke the policy and why; empty otherwise (and for posts an admin rejected without model evidence)',
  })
  moderationFindings!: ModerationFindingDto[];

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Reason an admin removed this post, shown only to the author when status is REMOVED',
  })
  removalReason?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: PostAppealSummaryDto,
    description:
      'Appeal eligibility and active/latest ticket summary; shown only to the author for REJECTED or admin-REMOVED posts',
  })
  appeal?: PostAppealSummaryDto | null;

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
