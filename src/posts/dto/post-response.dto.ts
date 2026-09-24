import { ApiProperty } from '@nestjs/swagger';
import { PostStatus, PostType } from '@prisma/client';
import { MediaResponseDto } from '../../media/dto/media-response.dto';

export class PostAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'vedora.user' })
  username!: string;

  @ApiProperty({ example: 'Vedora User' })
  fullName!: string;
}

export class PostResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PostType })
  type!: PostType;

  @ApiProperty({
    enum: PostStatus,
    description:
      'PROCESSING until every video is ready; only the author sees non-PUBLISHED posts',
  })
  status!: PostStatus;

  @ApiProperty({ nullable: true, type: String })
  body!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  publishedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: PostAuthorDto })
  author!: PostAuthorDto;

  @ApiProperty({ type: [MediaResponseDto] })
  media!: MediaResponseDto[];
}

export class PostPageDto {
  @ApiProperty({ type: [PostResponseDto] })
  items!: PostResponseDto[];

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  nextCursor!: string | null;
}
