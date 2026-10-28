import { ApiProperty } from '@nestjs/swagger';
import { FollowSuggestionReason } from '../../mongo/models.js';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ProfileSummaryDto } from './profile.dto.js';

export const MAX_SUGGESTIONS = 20;

export class FollowSuggestionQueryDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SUGGESTIONS)
  limit: number = 5;
}

export class FollowSuggestionDto extends ProfileSummaryDto {
  @ApiProperty({
    enum: [...Object.values(FollowSuggestionReason), 'ACTIVE'],
    description:
      'FOLLOWS_YOU: they follow you. MUTUAL: followed by people you follow. ACTIVE: recently posting, used when there is no graph signal.',
  })
  reason!: FollowSuggestionReason | 'ACTIVE';

  @ApiProperty({
    description: 'People you follow who follow them; 0 unless MUTUAL',
  })
  mutualCount!: number;
}

export class FollowSuggestionListDto {
  @ApiProperty({ type: [FollowSuggestionDto] }) items!: FollowSuggestionDto[];
}
