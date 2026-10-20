import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class SetRecipeRatingDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 4 })
  @IsInt()
  @Min(1)
  @Max(5)
  value!: number;
}

export class RecipeRatingSummaryDto {
  @ApiProperty({ format: 'uuid' }) recipeId!: string;
  @ApiProperty({ minimum: 0 }) ratingCount!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4.5,
    description:
      'Mean rounded to one decimal; null when no eligible ratings exist',
  })
  averageRating!: number | null;
}

export class MyRecipeRatingDto extends RecipeRatingSummaryDto {
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 5 })
  myRating!: number | null;
}
