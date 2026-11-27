import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
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

export const MAX_MEMORY_ITEMS = 30;
export const MAX_MEMORY_ITEM_LENGTH = 200;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const cleanLines = ({ value }: { value: unknown }): unknown => {
  if (!Array.isArray(value)) return value;
  const lines: unknown[] = [];
  for (const item of value) {
    const line: unknown = typeof item === 'string' ? item.trim() : item;
    if (line === '' || lines.includes(line)) continue;
    lines.push(line);
  }
  return lines;
};

export class DietaryMemoryDto {
  @ApiProperty({
    type: [String],
    description:
      'Allergies, intolerances and things the user must never eat (health, religion), one short natural-language line each',
  })
  allergies!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Lasting tastes and habits the planner keeps in mind (dislikes, meals cooked at home, budget, household size), one line each',
  })
  preferences!: string[];
}

export class SaveDietaryMemoryDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_MEMORY_ITEMS,
    description: `Replaces the allergy lines (each ≤ ${MAX_MEMORY_ITEM_LENGTH} chars, trimmed, blanks and repeats dropped); omit to keep them`,
  })
  @IsOptional()
  @Transform(cleanLines)
  @IsArray()
  @ArrayMaxSize(MAX_MEMORY_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_MEMORY_ITEM_LENGTH, { each: true })
  allergies?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_MEMORY_ITEMS,
    description: `Replaces the preference lines (each ≤ ${MAX_MEMORY_ITEM_LENGTH} chars, trimmed, blanks and repeats dropped); omit to keep them`,
  })
  @IsOptional()
  @Transform(cleanLines)
  @IsArray()
  @ArrayMaxSize(MAX_MEMORY_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_MEMORY_ITEM_LENGTH, { each: true })
  preferences?: string[];
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
