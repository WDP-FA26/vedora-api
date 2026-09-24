import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListPostsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: '`nextCursor` from the previous page',
  })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this author' })
  @IsOptional()
  @IsUUID('4')
  authorId?: string;
}
