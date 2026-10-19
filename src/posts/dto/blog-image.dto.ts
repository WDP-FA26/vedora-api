import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { SignedUploadDto } from '../../media/dto/media-response.dto';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto';

export const BLOG_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const MAX_BLOG_IMAGE_BYTES = 5 * 1024 * 1024;

export class CreateBlogImageUploadDto {
  @ApiProperty({ enum: BLOG_IMAGE_TYPES })
  @IsIn(BLOG_IMAGE_TYPES)
  contentType!: (typeof BLOG_IMAGE_TYPES)[number];

  @ApiProperty({ minimum: 1, maximum: MAX_BLOG_IMAGE_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_BLOG_IMAGE_BYTES)
  sizeBytes!: number;
}

export class BlogImageUploadDto {
  @ApiProperty({
    type: PresignedUploadDto,
    description: 'PUT the image here within the hour',
  })
  upload!: PresignedUploadDto;

  @ApiProperty({
    description:
      'Permanent public URL of the image once uploaded; put it in the blog Markdown',
  })
  url!: string;
}

export class BlogVideoUploadDto {
  @ApiProperty({ type: SignedUploadDto })
  upload!: SignedUploadDto;

  @ApiProperty({
    description:
      'Public MP4 URL once uploaded; put it in the blog Markdown as ![caption](url)',
  })
  url!: string;
}
