import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpdateKnowledgePageDto {
  @ApiProperty({ description: 'The corrected page text. May be empty.' })
  @IsString()
  @MaxLength(runtimeConfig.KNOWLEDGE_PAGE_MAX_LENGTH)
  text!: string;
}
