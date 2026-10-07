import { ApiProperty } from '@nestjs/swagger';
import {
  CaptionStatus,
  MediaFailureReason,
  MediaStatus,
  MediaType,
} from '@prisma/client';

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
    nullable: true,
    type: String,
    description: 'Mux public playback ID, set once READY',
  })
  playbackId!: string | null;

  @ApiProperty({ nullable: true, type: Number, example: 42.5 })
  durationSec!: number | null;

  @ApiProperty({ nullable: true, type: String, example: '16:9' })
  aspectRatio!: string | null;
}

export class CaptionTrackDto {
  @ApiProperty({ description: 'Mux text track ID' })
  id!: string;

  @ApiProperty({ nullable: true, type: String, example: 'vi' })
  languageCode!: string | null;

  @ApiProperty({ example: 'Tiếng Việt' })
  name!: string;

  @ApiProperty({
    description: 'The spoken language, as opposed to its translation',
  })
  isOriginal!: boolean;

  @ApiProperty({ description: 'Public WebVTT file on Mux' })
  url!: string;
}

export class AdminMediaDto extends MediaResponseDto {
  @ApiProperty({ enum: CaptionStatus })
  captionStatus!: CaptionStatus;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'vi',
    description: 'Spoken language Mux detected',
  })
  captionLanguage!: string | null;
}

export class AdminMediaDetailDto extends AdminMediaDto {
  @ApiProperty({
    type: [CaptionTrackDto],
    description: 'Ready caption tracks, spoken language first',
  })
  captions!: CaptionTrackDto[];
}

export class CreateUploadResponseDto {
  @ApiProperty({ type: MediaResponseDto })
  media!: MediaResponseDto;

  @ApiProperty({
    description:
      'Mux direct-upload URL. PUT the file here from the browser (e.g. with UpChunk); it expires after an hour.',
  })
  uploadUrl!: string;
}
