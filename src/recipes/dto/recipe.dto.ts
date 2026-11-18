import { runtimeConfig } from '../../config/runtime-config.js';
import { SignedUploadDto } from '../../media/dto/media-response.dto.js';
import { RecipeTag } from '../../mongo/models.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
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

export const MAX_RECIPE_INGREDIENTS = runtimeConfig.RECIPE_MAX_INGREDIENTS;
export const MAX_RECIPE_STEPS = runtimeConfig.RECIPE_MAX_STEPS;
export const MAX_STEP_LENGTH = runtimeConfig.RECIPE_STEP_MAX_LENGTH;
const MAX_MINUTES = runtimeConfig.RECIPE_MAX_MINUTES;
export const MAX_IMAGE_URL_LENGTH = runtimeConfig.RECIPE_IMAGE_URL_MAX_LENGTH;

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
  @Max(runtimeConfig.RECIPE_INGREDIENT_MAX_QUANTITY)
  quantity?: number;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.RECIPE_UNIT_MAX_LENGTH,
    example: 'g',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.RECIPE_UNIT_MAX_LENGTH)
  unit?: string;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.RECIPE_NOTE_MAX_LENGTH,
    example: 'cắt hạt lựu',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.RECIPE_NOTE_MAX_LENGTH)
  note?: string;
}

export class SaveRecipeDto {
  @ApiProperty({ maxLength: runtimeConfig.RECIPE_TITLE_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.RECIPE_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.RECIPE_DESCRIPTION_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.RECIPE_DESCRIPTION_MAX_LENGTH)
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

  @ApiPropertyOptional({
    enum: RecipeTag,
    nullable: true,
    description:
      'Kind of dish, shown as an icon in the meal planner; omit or send null for the default icon',
  })
  @IsOptional()
  @IsEnum(RecipeTag)
  tag?: RecipeTag | null;

  @ApiProperty({ minimum: 1, maximum: runtimeConfig.RECIPE_MAX_SERVINGS })
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.RECIPE_MAX_SERVINGS)
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
  @ApiProperty({ enum: RecipeTag, nullable: true })
  tag!: RecipeTag | null;
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

export function toRecipeCard({
  description: _description,
  steps: _steps,
  ingredients: _ingredients,
  ...card
}: RecipeDetailDto): RecipeDto {
  return card;
}

export class RecipeImageUploadDto {
  @ApiProperty({ type: SignedUploadDto })
  upload!: SignedUploadDto;

  @ApiProperty({
    format: 'uri',
    description: 'Public image URL once uploaded; send it as `imageUrl`',
  })
  url!: string;
}
