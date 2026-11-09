import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType, PostType } from '../../mongo/models.js';
import { CursorPaginatedResponseDto } from '../../common/pagination/index.js';
import { PostAuthorDto } from '../../posts/dto/post-response.dto.js';

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: NotificationType })
  type!: NotificationType;

  @ApiProperty({
    type: PostAuthorDto,
    nullable: true,
    description:
      'Null for notifications from Vedora itself, such as moderation',
  })
  actor!: PostAuthorDto | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  postId!: string | null;

  @ApiProperty({
    enum: PostType,
    nullable: true,
    description: 'Whether `postId` is a short post or a blog',
  })
  postType!: PostType | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  commentId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Moderation only: sexual, violence, hate, harassment, self_harm, illegal or spam',
  })
  reason!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Moderation only: `reason` worded for the author, e.g. "bạo lực hoặc đe dọa". Null if the category no longer exists',
  })
  reasonText!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: "Moderation only: the admin's note",
  })
  note!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  readAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class NotificationPageDto extends CursorPaginatedResponseDto<NotificationDto> {
  @ApiProperty({ type: [NotificationDto] })
  declare items: NotificationDto[];
}

export class UnreadCountDto {
  @ApiProperty({ minimum: 0 })
  unreadCount!: number;
}
