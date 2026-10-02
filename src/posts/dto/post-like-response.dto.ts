import { ApiProperty } from '@nestjs/swagger';

export class PostLikeResponseDto {
  @ApiProperty({ format: 'uuid' })
  postId!: string;

  @ApiProperty()
  isLiked!: boolean;

  @ApiProperty({ minimum: 0 })
  likeCount!: number;
}
