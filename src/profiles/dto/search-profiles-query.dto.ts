import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { PaginationLimitDto } from '../../common/pagination/index.js';
import { MAX_PROFILE_SEARCH_RESULTS } from '../search/profile-search.service.js';

export const MAX_PROFILE_SEARCH_QUERY_LENGTH =
  runtimeConfig.SEARCH_QUERY_MAX_LENGTH;

export class SearchProfilesQueryDto extends PaginationLimitDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_PROFILE_SEARCH_QUERY_LENGTH,
    description:
      'Name, @username, or bio keywords to match with BM25 (accents optional)',
  })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @Length(1, MAX_PROFILE_SEARCH_QUERY_LENGTH)
  q!: string;

  @ApiPropertyOptional({
    description:
      '`nextCursor` from the previous response; omit for the first page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PROFILE_SEARCH_RESULTS)
  cursor?: number;
}
