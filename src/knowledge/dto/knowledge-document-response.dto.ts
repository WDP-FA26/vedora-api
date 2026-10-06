import { ApiProperty } from '@nestjs/swagger';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto';

export class KnowledgeDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'bang-thanh-phan-dinh-duong.pdf' })
  title!: string;

  @ApiProperty({ enum: KnowledgeDocumentStatus })
  status!: KnowledgeDocumentStatus;

  @ApiProperty({
    enum: KnowledgeDocumentFailureReason,
    nullable: true,
    description: 'Why ingestion failed; set when status is FAILED',
  })
  failureReason!: KnowledgeDocumentFailureReason | null;

  @ApiProperty({ example: 'application/pdf' })
  contentType!: string;

  @ApiProperty({
    nullable: true,
    type: Number,
    example: 12,
    description: 'Extracted text sections (pages for PDFs), set once READY',
  })
  sectionCount!: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 3 })
  imageCount!: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 482133 })
  sizeBytes!: number | null;

  @ApiProperty()
  createdAt!: Date;
}

export class CreateKnowledgeUploadResponseDto {
  @ApiProperty({ type: KnowledgeDocumentResponseDto })
  document!: KnowledgeDocumentResponseDto;

  @ApiProperty({
    type: PresignedUploadDto,
    description:
      'PUT the PDF here within the hour. Ingestion starts when RustFS reports the upload, so poll GET /knowledge/documents.',
  })
  upload!: PresignedUploadDto;
}
