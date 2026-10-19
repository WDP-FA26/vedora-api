import { ApiProperty } from '@nestjs/swagger';
import {
  CaptionStatus,
  MediaFailureReason,
  MediaStatus,
  MediaType,
} from '@prisma/client';

export class CaptionTrackDto {
  @ApiProperty({ example: 'vi' })
  languageCode!: string;

  @ApiProperty({ example: 'Tiếng Việt' })
  name!: string;

  @ApiProperty({
    description: 'The spoken language, as opposed to its translation',
  })
  isOriginal!: boolean;

  @ApiProperty({ description: 'Public WebVTT file on Cloudinary' })
  url!: string;
}

export class MediaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MediaType })
  type!: MediaType;

  @ApiProperty({ enum: MediaStatus })
  status!: MediaStatus;

  @ApiProperty({
    enum: MediaFailureReason,
    nullable: true,
    description: 'Why processing failed; set when status is FAILED',
  })
  failureReason!: MediaFailureReason | null;

  @ApiProperty({
    example: 'vedora/videos/0b0d9c3e-3f0c-4c5e-9d0a-2b7f1f4d8a11',
    description: 'Cloudinary public ID, for next-cloudinary components',
  })
  publicId!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Adaptive HLS stream (`sp_auto`), set once READY',
  })
  playbackUrl!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'First frame as JPEG, set once READY',
  })
  posterUrl!: string | null;

  @ApiProperty({ nullable: true, type: Number, example: 42.5 })
  durationSec!: number | null;

  @ApiProperty({ nullable: true, type: String, example: '16:9' })
  aspectRatio!: string | null;

  @ApiProperty({
    type: [CaptionTrackDto],
    description:
      'Caption tracks, spoken language first; empty until the post is published and transcribed',
  })
  captions!: CaptionTrackDto[];
}

export class AdminMediaDto extends MediaResponseDto {
  @ApiProperty({ enum: CaptionStatus })
  captionStatus!: CaptionStatus;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'vi',
    description: 'Spoken language Whisper detected',
  })
  captionLanguage!: string | null;
}

export class SignedUploadDto {
  @ApiProperty({
    example: 'https://api.cloudinary.com/v1_1/demo/video/upload',
    description: 'POST the file here as multipart/form-data',
  })
  url!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Send every field as-is next to `file`. The signature expires after an hour.',
  })
  fields!: Record<string, string>;

  @ApiProperty({
    example: 20971520,
    description:
      'Larger files go in chunks of this many bytes, each with the same fields plus `X-Unique-Upload-Id` and `Content-Range` headers',
  })
  chunkSize!: number;
}

export class CreateUploadResponseDto {
  @ApiProperty({ type: MediaResponseDto })
  media!: MediaResponseDto;

  @ApiProperty({ type: SignedUploadDto })
  upload!: SignedUploadDto;
}
