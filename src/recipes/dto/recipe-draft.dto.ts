import { runtimeConfig } from '../../config/runtime-config.js';
import { RecipeTag } from '../../mongo/models.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { NamedRefDto } from './ingredient.dto.js';

const MAX_TEXT_LENGTH = runtimeConfig.RECIPE_DRAFT_MAX_TEXT_LENGTH;
const MAX_INSTRUCTION_LENGTH =
  runtimeConfig.RECIPE_DRAFT_MAX_INSTRUCTION_LENGTH;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const CALORIE_RESEARCH_STATUSES = ['DONE', 'SKIPPED', 'FAILED'] as const;
export type CalorieResearchStatus = (typeof CALORIE_RESEARCH_STATUSES)[number];

export class CreateRecipeDraftDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Read the post: its text and the transcript of each ready video. Send this, `text` or `currentRecipe`.',
  })
  @IsOptional()
  @IsUUID('4')
  postId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'With `postId`: read only this video of the post (plus the post text), not every video.',
  })
  @IsOptional()
  @IsUUID('4')
  mediaId?: string;

  @ApiPropertyOptional({
    maxLength: MAX_TEXT_LENGTH,
    description:
      'A caption or recipe text pasted by the admin. Send this, `postId` or `currentRecipe`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  text?: string;

  @ApiPropertyOptional({
    maxLength: MAX_TEXT_LENGTH,
    description:
      'The recipe on the admin form now, as plain text, to revise with `instruction`. Send this, `postId` or `text`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  currentRecipe?: string;

  @ApiPropertyOptional({
    maxLength: MAX_INSTRUCTION_LENGTH,
    example: 'Đổi khẩu phần thành 4 người và tính lại Kcal.',
    description:
      "The admin's own request. The only part of the body the AI follows as instructions; post text, transcripts and `currentRecipe` are read as data.",
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_INSTRUCTION_LENGTH)
  instruction?: string;
}

export class IngredientSuggestionDto {
  @ApiProperty({ example: 'đậu hũ non' }) name!: string;
  @ApiProperty({ type: [String], example: ['tàu hũ non', 'silken tofu'] })
  aliases!: string[];
  @ApiProperty({ type: [NamedRefDto] }) groups!: NamedRefDto[];
}

export class RecipeDraftIngredientDto {
  @ApiProperty({ description: 'The ingredient as the source names it' })
  name!: string;
  @ApiProperty({ type: Number, nullable: true }) quantity!: number | null;
  @ApiProperty({ type: String, nullable: true }) unit!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;

  @ApiProperty({
    type: NamedRefDto,
    nullable: true,
    description: 'The catalog ingredient, or null when the catalog has none',
  })
  match!: NamedRefDto | null;

  @ApiProperty({
    type: IngredientSuggestionDto,
    nullable: true,
    description:
      'Prefill for `POST /admin/ingredients` when `match` is null; null otherwise',
  })
  suggestion!: IngredientSuggestionDto | null;
}

export class RecipeDraftSourceLinkDto {
  @ApiProperty() title!: string;
  @ApiProperty({ format: 'uri' }) url!: string;
}

export class RecipeDraftRecipeDto {
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: RecipeTag, nullable: true }) tag!: RecipeTag | null;
  @ApiProperty({ type: Number, nullable: true }) servings!: number | null;
  @ApiProperty({ type: Number, nullable: true }) prepMinutes!: number | null;
  @ApiProperty({ type: Number, nullable: true }) cookMinutes!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  caloriesPerServing?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  calorieNote?: string | null;
  @ApiPropertyOptional({ type: [RecipeDraftSourceLinkDto] })
  calorieSources?: RecipeDraftSourceLinkDto[];
  @ApiProperty({ type: [RecipeDraftIngredientDto] })
  ingredients!: RecipeDraftIngredientDto[];
  @ApiProperty({ type: [String] }) steps!: string[];
}

export class RecipeDraftDto {
  @ApiProperty({
    type: RecipeDraftRecipeDto,
    nullable: true,
    description: 'Null when the source teaches no dish',
  })
  recipe!: RecipeDraftRecipeDto | null;

  @ApiProperty({
    minimum: 0,
    description:
      'Videos of the post still waiting for a transcript; what they say is missing from the draft',
  })
  untranscribedVideos!: number;

  @ApiProperty({
    enum: CALORIE_RESEARCH_STATUSES,
    description:
      "`DONE`: kcal checked on the web (see `calorieSources`). `SKIPPED`: no check was needed, e.g. the request only reworded the recipe, or there is no recipe. `FAILED`: the web check failed or found nothing; `caloriesPerServing` is the AI's own estimate or the form's value.",
  })
  calorieResearch!: CalorieResearchStatus;
}
