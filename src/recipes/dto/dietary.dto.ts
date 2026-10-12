import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AllergyAcknowledgement,
  AllergenLabel,
  AnimalLabel,
  DietMode,
  ExclusionReason,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NamedRefDto } from './ingredient.dto';

export const MAX_AVOIDED_INGREDIENTS = 200;
export const MAX_AVOIDED_GROUPS = 50;
export const MAX_LIKED_INGREDIENTS = 100;
export const MAX_MANUAL_EXCLUSIONS = 300;

export class DietaryIngredientOptionDto extends NamedRefDto {
  @ApiProperty({ type: [String] }) aliases!: string[];
}

export class DietaryGroupOptionDto extends NamedRefDto {
  @ApiProperty({ type: [String], description: 'Names of its ingredients' })
  ingredients!: string[];
}

export class DietaryOptionsDto {
  @ApiProperty({ enum: AnimalLabel, isArray: true })
  animalLabels!: AnimalLabel[];
  @ApiProperty({ enum: AllergenLabel, isArray: true })
  allergenLabels!: AllergenLabel[];
  @ApiProperty({ type: [DietaryIngredientOptionDto] })
  ingredients!: DietaryIngredientOptionDto[];

  @ApiProperty({ type: [DietaryGroupOptionDto] })
  groups!: DietaryGroupOptionDto[];
}

export class DietaryRestrictionsDto {
  @ApiProperty({ enum: DietMode }) dietMode!: DietMode;
  @ApiProperty({ enum: AllergyAcknowledgement })
  allergyAcknowledgement!: AllergyAcknowledgement;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: Date }) updatedAt!: Date | null;
  @ApiProperty() readyForMealPlanning!: boolean;
  @ApiProperty({ type: () => [DietaryExclusionDto] })
  exclusions!: DietaryExclusionDto[];
  @ApiProperty({ type: [NamedRefDto] }) ingredients!: NamedRefDto[];
  @ApiProperty({ type: [NamedRefDto] }) groups!: NamedRefDto[];

  @ApiProperty({
    type: [NamedRefDto],
    description: 'Ingredients the user likes; a taste, never a rule',
  })
  liked!: NamedRefDto[];
}

export class SaveDietaryRestrictionsDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedVersion!: number;
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

export const EXCLUSION_KINDS = [
  'INGREDIENT',
  'GROUP',
  'ANIMAL',
  'ALLERGEN',
] as const;
export class DietaryExclusionDto {
  @ApiProperty({ enum: EXCLUSION_KINDS })
  @IsIn(EXCLUSION_KINDS)
  kind!: (typeof EXCLUSION_KINDS)[number];

  @ApiProperty({
    description: 'Ingredient/Group UUID or canonical Animal/Allergen label',
  })
  @IsString()
  @MaxLength(36)
  target!: string;

  @ApiProperty({ enum: ExclusionReason, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsEnum(ExclusionReason, { each: true })
  reasons!: ExclusionReason[];
}

export class PatchDietaryProfileDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedVersion!: number;

  @ApiPropertyOptional({ enum: DietMode })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(DietMode)
  dietMode?: DietMode;

  @ApiPropertyOptional({ enum: AllergyAcknowledgement })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(AllergyAcknowledgement)
  allergyAcknowledgement?: AllergyAcknowledgement;

  @ApiPropertyOptional({
    type: [DietaryExclusionDto],
    description:
      'Replace manual exclusions; automatic DIET exclusions are managed by the server',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_MANUAL_EXCLUSIONS + Object.values(AnimalLabel).length)
  @ArrayUnique((item: DietaryExclusionDto | null) =>
    item
      ? `${item.kind}:${typeof item.target === 'string' ? item.target.toLowerCase() : item.target}`
      : item,
  )
  @ValidateNested({ each: true })
  @Type(() => DietaryExclusionDto)
  exclusions?: DietaryExclusionDto[];

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_LIKED_INGREDIENTS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  likedIngredientIds?: string[];
}
