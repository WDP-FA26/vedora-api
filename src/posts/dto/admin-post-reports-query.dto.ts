import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PostReportsQueryDto } from './post-interaction.dto.js';

export class AdminPostReportsQueryDto extends PostReportsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  postId?: string;
}
