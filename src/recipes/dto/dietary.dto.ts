import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ActivityLevel,
  BiologicalSex,
  BmiCategory,
  BodyFeeling,
  NutritionGoal,
} from '../../mongo/models.js';
import { NamedRefDto } from './ingredient.dto.js';

export const MAX_AVOIDED_INGREDIENTS =
  runtimeConfig.DIETARY_MAX_AVOIDED_INGREDIENTS;
export const MAX_AVOIDED_GROUPS = runtimeConfig.DIETARY_MAX_AVOIDED_GROUPS;
export const MAX_ALLERGY_NOTE_LENGTH = 1000;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

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

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: MAX_ALLERGY_NOTE_LENGTH,
    description:
      'Natural-language description of allergies, intolerances, and dietary rules',
  })
  allergyNote?: string | null;
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

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: MAX_ALLERGY_NOTE_LENGTH,
    description:
      'Optional free-text description of food allergies or restrictions checked by the planner subagent',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_ALLERGY_NOTE_LENGTH)
  allergyNote?: string | null;
}

export class SaveNutritionProfileDto {
  @ApiPropertyOptional({ nullable: true, minimum: 100, maximum: 250 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(100)
  @Max(250)
  heightCm?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 25, maximum: 300 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(25)
  @Max(300)
  weightKg?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 25, maximum: 300 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(25)
  @Max(300)
  targetWeightKg?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1920, maximum: 2020 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1920)
  @Max(2020)
  birthYear?: number | null;

  @ApiPropertyOptional({ enum: BiologicalSex, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(BiologicalSex)
  biologicalSex?: BiologicalSex | null;

  @ApiPropertyOptional({ enum: ActivityLevel, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(ActivityLevel)
  activityLevel?: ActivityLevel | null;

  @ApiPropertyOptional({ enum: NutritionGoal, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(NutritionGoal)
  nutritionGoal?: NutritionGoal | null;

  @ApiPropertyOptional({ enum: BodyFeeling, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(BodyFeeling)
  feeling?: BodyFeeling | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

export class WeightCheckInDto {
  @ApiProperty({ minimum: 25, maximum: 300 })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(25)
  @Max(300)
  weightKg!: number;

  @ApiPropertyOptional({ minimum: 100, maximum: 250 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(250)
  heightCm?: number;

  @ApiPropertyOptional({
    example: '2026-11-21',
    description: 'Calendar date YYYY-MM-DD in app timezone; defaults to today',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({ enum: BodyFeeling, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(BodyFeeling)
  feeling?: BodyFeeling | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

export class BodyMetricLogDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '2026-11-21' }) date!: string;
  @ApiProperty() weightKg!: number;
  @ApiProperty() heightCm!: number;
  @ApiProperty() bmi!: number;
  @ApiProperty({ enum: BodyFeeling, nullable: true })
  feeling!: BodyFeeling | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ type: Date }) updatedAt!: Date;
}

export class NutritionProfileDto {
  @ApiProperty({ nullable: true, type: Number }) heightCm!: number | null;
  @ApiProperty({ nullable: true, type: Number }) weightKg!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  targetWeightKg!: number | null;
  @ApiProperty({ nullable: true, type: Number }) birthYear!: number | null;
  @ApiProperty({ enum: BiologicalSex, nullable: true })
  biologicalSex!: BiologicalSex | null;
  @ApiProperty({ enum: ActivityLevel, nullable: true })
  activityLevel!: ActivityLevel | null;
  @ApiProperty({ enum: NutritionGoal, nullable: true })
  nutritionGoal!: NutritionGoal | null;

  @ApiProperty({ nullable: true, type: Number }) bmi!: number | null;
  @ApiProperty({ enum: BmiCategory, nullable: true })
  bmiCategory!: BmiCategory | null;
  @ApiProperty({ enum: NutritionGoal, nullable: true })
  suggestedGoal!: NutritionGoal | null;
  @ApiProperty({ enum: NutritionGoal, nullable: true })
  effectiveGoal!: NutritionGoal | null;
  @ApiProperty({ nullable: true, type: Number })
  idealWeightMinKg!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  idealWeightMaxKg!: number | null;
  @ApiProperty({ nullable: true, type: Number }) bmr!: number | null;
  @ApiProperty({ nullable: true, type: Number }) tdee!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  dailyCalorieTarget!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  dailyCalorieMin!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  dailyCalorieMax!: number | null;
  @ApiProperty({ nullable: true, type: String }) safetyNote!: string | null;

  @ApiProperty({ type: [BodyMetricLogDto] }) history!: BodyMetricLogDto[];
}
