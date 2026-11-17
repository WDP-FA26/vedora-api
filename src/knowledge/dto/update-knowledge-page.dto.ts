import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpdateKnowledgePageDto {
  @ApiProperty({ description: 'The corrected page text. May be empty.' })
  @IsString()
  @MaxLength(100_000)
  text!: string;
}
