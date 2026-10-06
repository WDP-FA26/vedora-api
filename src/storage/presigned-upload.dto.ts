import { ApiProperty } from '@nestjs/swagger';

export class PresignedUploadDto {
  @ApiProperty({
    description:
      'Presigned URL. Send the raw file as the body, with no Authorization header. Its exact size and type are part of the signature.',
  })
  url!: string;

  @ApiProperty({ enum: ['PUT'] })
  method!: 'PUT';

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'content-type': 'application/pdf' },
    description: 'Send these headers unchanged',
  })
  headers!: Record<string, string>;

  @ApiProperty({ description: 'The URL is rejected after this' })
  expiresAt!: Date;
}
