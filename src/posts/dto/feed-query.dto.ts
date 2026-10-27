import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { PaginationLimitDto } from '../../common/pagination';

/** `<offset>.<asOf in ms>`: later pages rank against the first page's time. */
export const FEED_CURSOR = /^(\d{1,3})\.(\d{1,15})$/;

export class FeedQueryDto extends PaginationLimitDto {
  @ApiPropertyOptional({
    description:
      '`nextCursor` from the previous response; omit for the first page',
  })
  @IsOptional()
  @Matches(FEED_CURSOR)
  cursor?: string;
}
