import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateKnowledgeUploadDto {
  @ApiProperty({
    example: 'bang-thanh-phan-dinh-duong.pdf',
    description:
      'Original file name. Its extension picks the file type (currently pdf); it is kept as the document title.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.KNOWLEDGE_FILENAME_MAX_LENGTH)
  filename!: string;

  @ApiProperty({ example: 482133, description: 'File size in bytes' })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
