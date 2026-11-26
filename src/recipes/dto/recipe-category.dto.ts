import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RecipeCategoryIcon, RecipeTag } from '../../mongo/models.js';
import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from './ingredient.dto.js';

export const MAX_RECIPE_CATEGORIES = 200;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SaveRecipeCategoryDto {
  @ApiProperty({ maxLength: MAX_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_NAME_LENGTH)
  name!: string;

  @ApiPropertyOptional({ maxLength: MAX_TEXT_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  description?: string;

  @ApiProperty({
    enum: RecipeTag,
    description:
      'Fixed dish kind the meal planner uses to place recipes of this category',
  })
  @IsEnum(RecipeTag)
  baseTag!: RecipeTag;

  @ApiPropertyOptional({
    enum: RecipeCategoryIcon,
    default: RecipeCategoryIcon.UTENSILS,
  })
  @IsOptional()
  @IsEnum(RecipeCategoryIcon)
  icon?: RecipeCategoryIcon;

  @ApiPropertyOptional({
    default: false,
    description: 'Hide the category from users without deleting it',
  })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;
}

export class ReorderRecipeCategoriesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Every category id, first to last',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RECIPE_CATEGORIES)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids!: string[];
}

export class RecipeCategoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: RecipeTag }) baseTag!: RecipeTag;
  @ApiProperty({ enum: RecipeCategoryIcon }) icon!: RecipeCategoryIcon;
  @ApiProperty({ description: 'Lower comes first' }) sortOrder!: number;
  @ApiProperty() hidden!: boolean;
  @ApiProperty() createdAt!: Date;
}
