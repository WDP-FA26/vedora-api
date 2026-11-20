import { ApiProperty } from '@nestjs/swagger';
import { PostSummaryStatus, RecipeTag } from '../../mongo/models.js';

export class SummaryIngredientDto {
  @ApiProperty({ example: 'đậu hũ non' })
  name!: string;

  @ApiProperty({ type: Number, nullable: true, example: 300 })
  quantity!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'g' })
  unit!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'cắt khối vuông' })
  note!: string | null;
}

export class SummaryRecipeDto {
  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ enum: RecipeTag, nullable: true })
  tag!: RecipeTag | null;

  @ApiProperty({ type: Number, nullable: true })
  servings!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  prepMinutes!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cookMinutes!: number | null;

  @ApiProperty({ type: [SummaryIngredientDto] })
  ingredients!: SummaryIngredientDto[];

  @ApiProperty({ type: [String] })
  steps!: string[];
}

export class PostSummaryDto {
  @ApiProperty({ format: 'uuid' })
  postId!: string;

  @ApiProperty({
    enum: PostSummaryStatus,
    description:
      'PENDING while Vedora AI works on it; SKIPPED when there was nothing to summarize; FAILED after the last retry.',
  })
  status!: PostSummaryStatus;

  @ApiProperty({ type: String, nullable: true, example: 'vi' })
  language!: string | null;

  @ApiProperty({ type: String, nullable: true })
  summary!: string | null;

  @ApiProperty({
    type: SummaryRecipeDto,
    nullable: true,
    description:
      'A recipe draft read from the post (null when it teaches no dish). Ingredient names are free text, not catalog ids.',
  })
  recipe!: SummaryRecipeDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The Vedora AI comment, or null when none is shown.',
  })
  commentId!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
