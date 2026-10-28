import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { NamedRefDto } from './ingredient.dto.js';

export const MAX_RECIPE_INGREDIENTS = 50;
export const MAX_RECIPE_STEPS = 50;
export const MAX_STEP_LENGTH = 1000;
const MAX_MINUTES = 24 * 60;
export const MAX_IMAGE_URL_LENGTH = 2048;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      )
    : value;

export class RecipeIngredientInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  ingredientId!: string;

  @ApiPropertyOptional({ minimum: 0.01, example: 200 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999999.99)
  quantity?: number;

  @ApiPropertyOptional({ maxLength: 30, example: 'g' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  unit?: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'cắt hạt lựu' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class SaveRecipeDto {
  @ApiProperty({ maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    format: 'uri',
    maxLength: MAX_IMAGE_URL_LENGTH,
    description: 'https link to a photo of the dish, shown as is',
  })
  @IsOptional()
  @Transform(trim)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(MAX_IMAGE_URL_LENGTH)
  imageUrl?: string;

  @ApiProperty({ minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  servings!: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINUTES)
  prepMinutes?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINUTES)
  cookMinutes?: number;

  @ApiProperty({ type: [RecipeIngredientInputDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RECIPE_INGREDIENTS)
  @ArrayUnique((item: RecipeIngredientInputDto) => item.ingredientId)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientInputDto)
  ingredients!: RecipeIngredientInputDto[];

  @ApiProperty({ type: [String], minItems: 1 })
  @Transform(trimEach)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RECIPE_STEPS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_STEP_LENGTH, { each: true })
  steps!: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The video post this recipe was written from',
  })
  @IsOptional()
  @IsUUID('4')
  postId?: string;
}

export class CheckConflictsDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(MAX_RECIPE_INGREDIENTS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ingredientIds!: string[];
}

export class RecipeConflictDto {
  @ApiProperty({ format: 'uuid' }) ruleId!: string;
  @ApiProperty({ type: NamedRefDto }) a!: NamedRefDto;
  @ApiProperty({ type: NamedRefDto }) b!: NamedRefDto;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) source!: string | null;
}

export class RecipePostAuthorDto {
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
}

export class RecipePostDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: RecipePostAuthorDto }) author!: RecipePostAuthorDto;
}

export class RecipeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uri' })
  imageUrl!: string | null;
  @ApiProperty() servings!: number;
  @ApiProperty({ nullable: true, type: Number }) prepMinutes!: number | null;
  @ApiProperty({ nullable: true, type: Number }) cookMinutes!: number | null;
  @ApiProperty({ minimum: 0 }) ingredientCount!: number;
  @ApiProperty({
    minimum: 0,
    description: 'Ingredient pairs an incompatibility rule forbids',
  })
  conflictCount!: number;
  @ApiProperty({ type: [RecipeConflictDto] }) conflicts!: RecipeConflictDto[];
  @ApiProperty({ nullable: true, type: RecipePostDto })
  post!: RecipePostDto | null;
  @ApiProperty() updatedAt!: Date;
}

export class RecipeIngredientDto {
  @ApiProperty({ format: 'uuid' }) ingredientId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: Number }) quantity!: number | null;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

export class RecipeDetailDto extends RecipeDto {
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ type: [String] }) steps!: string[];
  @ApiProperty({ type: [RecipeIngredientDto] })
  ingredients!: RecipeIngredientDto[];
}

/** The card fields of a detail, for lists. */
export function toRecipeCard({
  description: _description,
  steps: _steps,
  ingredients: _ingredients,
  ...card
}: RecipeDetailDto): RecipeDto {
  return card;
}
