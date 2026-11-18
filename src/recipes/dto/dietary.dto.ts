import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { NamedRefDto } from './ingredient.dto.js';

export const MAX_AVOIDED_INGREDIENTS =
  runtimeConfig.DIETARY_MAX_AVOIDED_INGREDIENTS;
export const MAX_AVOIDED_GROUPS = runtimeConfig.DIETARY_MAX_AVOIDED_GROUPS;
export const MAX_LIKED_INGREDIENTS =
  runtimeConfig.DIETARY_MAX_LIKED_INGREDIENTS;

export class DietaryIngredientOptionDto extends NamedRefDto {
  @ApiProperty({ type: [String] }) aliases!: string[];
}

export class DietaryGroupOptionDto extends NamedRefDto {
  @ApiProperty({ type: [String], description: 'Names of its ingredients' })
  ingredients!: string[];
}

export class DietaryOptionsDto {
  @ApiProperty({ type: [DietaryIngredientOptionDto] })
  ingredients!: DietaryIngredientOptionDto[];

  @ApiProperty({ type: [DietaryGroupOptionDto] })
  groups!: DietaryGroupOptionDto[];
}

export class DietaryRestrictionsDto {
  @ApiProperty({ type: [NamedRefDto] }) ingredients!: NamedRefDto[];
  @ApiProperty({ type: [NamedRefDto] }) groups!: NamedRefDto[];

  @ApiProperty({
    type: [NamedRefDto],
    description: 'Ingredients the user likes; a taste, never a rule',
  })
  liked!: NamedRefDto[];
}

export class SaveDietaryRestrictionsDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(MAX_AVOIDED_INGREDIENTS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ingredientIds!: string[];

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(MAX_AVOIDED_GROUPS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  groupIds!: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'May not repeat an id from ingredientIds',
  })
  @IsArray()
  @ArrayMaxSize(MAX_LIKED_INGREDIENTS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  likedIngredientIds!: string[];
}
