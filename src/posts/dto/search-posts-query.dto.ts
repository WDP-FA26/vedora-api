import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { PaginationLimitDto } from '../../common/pagination/index.js';
import { MAX_SEARCH_RESULTS } from '../search/post-search.service.js';

export const MAX_SEARCH_QUERY_LENGTH = 200;

export class SearchPostsQueryDto extends PaginationLimitDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_SEARCH_QUERY_LENGTH,
    description:
      'What to look for, in any language; matched by meaning and keywords',
  })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @Length(1, MAX_SEARCH_QUERY_LENGTH)
  q!: string;

  @ApiPropertyOptional({
    description:
      '`nextCursor` from the previous response; omit for the first page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_SEARCH_RESULTS)
  cursor?: number;
}
