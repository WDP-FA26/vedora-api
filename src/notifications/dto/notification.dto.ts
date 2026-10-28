import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '../../mongo/models.js';
import { CursorPaginatedResponseDto } from '../../common/pagination/index.js';
import { PostAuthorDto } from '../../posts/dto/post-response.dto.js';

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: NotificationType })
  type!: NotificationType;

  @ApiProperty({ type: PostAuthorDto })
  actor!: PostAuthorDto;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  postId!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  commentId!: string | null;

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
