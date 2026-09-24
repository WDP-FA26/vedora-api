import { ApiProperty } from '@nestjs/swagger';
import { MediaStatus, MediaType } from '@prisma/client';

export class MediaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MediaType })
  type!: MediaType;

  @ApiProperty({ enum: MediaStatus })
  status!: MediaStatus;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Why processing failed: TOO_LONG, ENCODING_FAILED, UPLOAD_ERRORED, UPLOAD_CANCELLED, UPLOAD_TIMED_OUT, NO_PLAYBACK_ID',
  })
  failureReason!: string | null;

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

export class CreateUploadResponseDto {
  @ApiProperty({ type: MediaResponseDto })
  media!: MediaResponseDto;

  @ApiProperty({
    description:
      'Mux direct-upload URL. PUT the file here from the browser (e.g. with UpChunk); it expires after an hour.',
  })
  uploadUrl!: string;
}
