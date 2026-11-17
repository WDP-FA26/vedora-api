import { ApiProperty } from '@nestjs/swagger';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
  KnowledgePageFlag,
} from '../../mongo/models.js';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto.js';

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

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  reviewedById!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  reviewedAt!: Date | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Admin note given when approving or rejecting',
  })
  reviewNote!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class KnowledgePageResponseDto {
  @ApiProperty({ example: 1, description: '1-based page number' })
  page!: number;

  @ApiProperty({ description: 'OCR text, Markdown' })
  text!: string;

  @ApiProperty({
    enum: KnowledgePageFlag,
    isArray: true,
    description:
      'TEXT_LAYER_ADDED: OCR missed words, so the PDF text layer was appended. PAGE_COUNT_MISMATCH: OCR returned a different number of pages, so the text may sit on the wrong page.',
  })
  flags!: KnowledgePageFlag[];

  @ApiProperty({ description: 'True once an admin changed the text' })
  edited!: boolean;
}

export class KnowledgeFileUrlResponseDto {
  @ApiProperty({ description: 'Presigned GET URL of the original PDF' })
  url!: string;

  @ApiProperty()
  expiresAt!: Date;
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
