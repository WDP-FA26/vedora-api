import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  PaginationMetaDto,
  PaginationQueryDto,
} from '../../common/pagination/index.js';

export const MAX_REVIEW_COMMENT_LENGTH = 1000;
export const REVIEW_SORTS = ['newest', 'highest', 'lowest'] as const;
export type RestaurantReviewSort = (typeof REVIEW_SORTS)[number];

const blankToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export class UpsertRestaurantReviewDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_REVIEW_COMMENT_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(MAX_REVIEW_COMMENT_LENGTH)
  comment?: string | null;
}

export class ListRestaurantReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: REVIEW_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(REVIEW_SORTS)
  sort: RestaurantReviewSort = 'newest';
}

export class RestaurantReviewAuthorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty() isProfessional!: boolean;
}

export class RestaurantReviewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: RestaurantReviewAuthorDto })
  author!: RestaurantReviewAuthorDto;
}

export class RestaurantRatingBreakdownDto {
  @ApiProperty({ minimum: 0 }) '1'!: number;
  @ApiProperty({ minimum: 0 }) '2'!: number;
  @ApiProperty({ minimum: 0 }) '3'!: number;
  @ApiProperty({ minimum: 0 }) '4'!: number;
  @ApiProperty({ minimum: 0 }) '5'!: number;
}

export class RestaurantReviewSummaryDto {
  @ApiProperty({ type: Number, nullable: true, example: 4.8 })
  averageRating!: number | null;

  @ApiProperty({ minimum: 0 })
  reviewCount!: number;

  @ApiProperty({ type: RestaurantRatingBreakdownDto })
  breakdown!: RestaurantRatingBreakdownDto;
}

export class RestaurantReviewPageDto {
  @ApiProperty({ type: RestaurantReviewSummaryDto })
  summary!: RestaurantReviewSummaryDto;

  @ApiProperty({ type: RestaurantReviewDto, nullable: true })
  myReview!: RestaurantReviewDto | null;

  @ApiProperty({ type: [RestaurantReviewDto] })
  items!: RestaurantReviewDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class RestaurantReviewMutationResponseDto {
  @ApiProperty({ type: RestaurantReviewDto })
  review!: RestaurantReviewDto;

  @ApiProperty({ type: RestaurantReviewSummaryDto })
  summary!: RestaurantReviewSummaryDto;
}
