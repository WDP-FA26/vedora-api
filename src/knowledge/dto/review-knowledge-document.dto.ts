import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewKnowledgeDocumentDto {
  @ApiPropertyOptional({
    maxLength: runtimeConfig.KNOWLEDGE_REVIEW_NOTE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(runtimeConfig.KNOWLEDGE_REVIEW_NOTE_MAX_LENGTH)
  note?: string;
}
