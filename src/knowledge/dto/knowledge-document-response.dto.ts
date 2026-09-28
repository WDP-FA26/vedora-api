import { ApiProperty } from '@nestjs/swagger';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';

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
    example: 'knowledge/0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10.pdf',
    description: 'Upload the file to exactly this pathname',
  })
  pathname!: string;

  @ApiProperty({
    description:
      "Vercel Blob client token, valid for this pathname and the document's content type only. Pass it to `put(pathname, file, { access: 'private', token, contentType })` from '@vercel/blob/client'; it expires after an hour. Ingestion starts when Vercel Blob's callback reaches the API, so poll GET /knowledge/documents.",
  })
  clientToken!: string;
}
