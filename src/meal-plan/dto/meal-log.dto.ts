import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  CalorieSource,
  MealLogSource,
  MealSection,
  Weekday,
} from '../../mongo/models.js';
import { isCalendarDate } from '../meal-week.js';
import { OptionalWeekStart } from './week-start.js';

export const MEAL_LOG_MAX_NAME_LENGTH = 120;
export const MEAL_LOG_MAX_NOTE_LENGTH = 500;
export const MEAL_LOG_MAX_DETAILS_LENGTH = 300;
export const MEAL_LOG_MAX_REFERENCES = 5;
export const MEAL_LOG_MIN_SERVINGS = 0.25;
export const MEAL_LOG_MAX_SERVINGS = 20;
export const MEAL_LOG_MAX_CALORIES_PER_SERVING = 5000;

/** Calorie sources a client may set; RECIPE is set by the API only. */
export const CLIENT_CALORIE_SOURCES = [
  CalorieSource.USER,
  CalorieSource.WEB_ESTIMATE,
] as const;
export type ClientCalorieSource = (typeof CLIENT_CALORIE_SOURCES)[number];

@ValidatorConstraint({ name: 'isCalendarDate', async: false })
class IsCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isCalendarDate(value);
  }

  defaultMessage(): string {
    return 'date must be a calendar date written YYYY-MM-DD';
  }
}

export class CalorieReferenceDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ format: 'uri', maxLength: 2048 })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  url!: string;
}

class Servings {
  @ApiPropertyOptional({
    minimum: MEAL_LOG_MIN_SERVINGS,
    maximum: MEAL_LOG_MAX_SERVINGS,
    default: 1,
    description: 'How many servings were eaten, e.g. 0.5 or 1.5',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MEAL_LOG_MIN_SERVINGS)
  @Max(MEAL_LOG_MAX_SERVINGS)
  servings?: number;
}

export class CreateMealLogEntryDto extends Servings {
  @ApiProperty({
    example: '2026-11-24',
    description:
      'Calendar date in the app time zone, `YYYY-MM-DD`: today or one of the MEAL_LOG_EDITABLE_DAYS days before it',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @Validate(IsCalendarDateConstraint)
  date!: string;

  @ApiProperty({ enum: MealSection })
  @IsEnum(MealSection)
  section!: MealSection;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A catalog recipe. Send exactly one of `recipeId` and `name`. It is logged as PLAN when it is in the plan for that meal, else RECIPE.',
  })
  @IsOptional()
  @IsUUID('4')
  recipeId?: string;

  @ApiPropertyOptional({
    maxLength: MEAL_LOG_MAX_NAME_LENGTH,
    description: 'A dish outside the catalog (CUSTOM)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MEAL_LOG_MAX_NAME_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MEAL_LOG_MAX_CALORIES_PER_SERVING,
    description:
      'kcal per serving. For a recipe it overrides the recipe value; for a custom dish leave it out when unknown',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MEAL_LOG_MAX_CALORIES_PER_SERVING)
  caloriesPerServing?: number;

  @ApiPropertyOptional({
    enum: CLIENT_CALORIE_SOURCES,
    description:
      'Where `caloriesPerServing` came from: USER (typed) or WEB_ESTIMATE (from `POST /meal-plan/log/calorie-estimate`). Defaults to USER',
  })
  @IsOptional()
  @IsIn(CLIENT_CALORIE_SOURCES)
  calorieSource?: ClientCalorieSource;

  @ApiPropertyOptional({ maxLength: MEAL_LOG_MAX_NOTE_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MEAL_LOG_MAX_NOTE_LENGTH)
  calorieNote?: string;

  @ApiPropertyOptional({
    type: [CalorieReferenceDto],
    maxItems: MEAL_LOG_MAX_REFERENCES,
    description: 'Sources of a WEB_ESTIMATE; ignored for other sources',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEAL_LOG_MAX_REFERENCES)
  @ValidateNested({ each: true })
  @Type(() => CalorieReferenceDto)
  calorieReferences?: CalorieReferenceDto[];
}

export class UpdateMealLogEntryDto extends Servings {
  @ApiPropertyOptional({ enum: MealSection })
  @IsOptional()
  @IsEnum(MealSection)
  section?: MealSection;

  @ApiPropertyOptional({
    maxLength: MEAL_LOG_MAX_NAME_LENGTH,
    description: 'Custom dishes only',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MEAL_LOG_MAX_NAME_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MEAL_LOG_MAX_CALORIES_PER_SERVING,
    description: 'null clears it',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MEAL_LOG_MAX_CALORIES_PER_SERVING)
  caloriesPerServing?: number | null;

  @ApiPropertyOptional({
    enum: CLIENT_CALORIE_SOURCES,
    description: 'Defaults to USER when `caloriesPerServing` is sent',
  })
  @IsOptional()
  @IsIn(CLIENT_CALORIE_SOURCES)
  calorieSource?: ClientCalorieSource;

  @ApiPropertyOptional({ maxLength: MEAL_LOG_MAX_NOTE_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MEAL_LOG_MAX_NOTE_LENGTH)
  calorieNote?: string;

  @ApiPropertyOptional({
    type: [CalorieReferenceDto],
    maxItems: MEAL_LOG_MAX_REFERENCES,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEAL_LOG_MAX_REFERENCES)
  @ValidateNested({ each: true })
  @Type(() => CalorieReferenceDto)
  calorieReferences?: CalorieReferenceDto[];
}

export class MealLogWeekQueryDto {
  @OptionalWeekStart()
  weekStart?: string;
}

export class EstimateCaloriesDto extends Servings {
  @ApiProperty({
    maxLength: MEAL_LOG_MAX_NAME_LENGTH,
    example: 'Bún riêu chay',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MEAL_LOG_MAX_NAME_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    maxLength: MEAL_LOG_MAX_DETAILS_LENGTH,
    example: 'Tô lớn ở quán, thêm đậu hũ chiên',
    description: 'Portion, where it was bought, how it was cooked',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MEAL_LOG_MAX_DETAILS_LENGTH)
  details?: string;
}

export class CalorieEstimateDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Estimated kcal per serving; null when nothing reliable was found',
  })
  caloriesPerServing!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'How the estimate was reached, in Vietnamese',
  })
  note!: string | null;

  @ApiProperty({ type: [CalorieReferenceDto] })
  references!: CalorieReferenceDto[];
}

export class MealLogEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '2026-11-24' }) date!: string;
  @ApiProperty({ enum: MealSection }) section!: MealSection;
  @ApiProperty({ enum: MealLogSource }) source!: MealLogSource;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null for a custom dish or a recipe deleted since',
  })
  recipeId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() servings!: number;
  @ApiProperty({ type: Number, nullable: true })
  caloriesPerServing!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'caloriesPerServing × servings, rounded',
  })
  calories!: number | null;
  @ApiProperty({
    enum: CalorieSource,
    nullable: true,
    description:
      'WEB_ESTIMATE is an AI estimate: show it as approximate (e.g. "~450 kcal")',
  })
  calorieSource!: CalorieSource | null;
  @ApiProperty({ type: String, nullable: true }) calorieNote!: string | null;
  @ApiProperty({ type: [CalorieReferenceDto] })
  calorieReferences!: CalorieReferenceDto[];
  @ApiProperty() createdAt!: string;
}

export class MealLogDayDto {
  @ApiProperty({ enum: Weekday }) day!: Weekday;
  @ApiProperty({ example: '2026-11-24' }) date!: string;
  @ApiProperty({
    description:
      'true for today and the MEAL_LOG_EDITABLE_DAYS days before it: entries can be added, changed or removed',
  })
  loggable!: boolean;
  @ApiProperty({
    type: [MealLogEntryDto],
    description: 'By section, then time',
  })
  entries!: MealLogEntryDto[];
  @ApiProperty({
    description: 'Sum of the entries whose calories are known',
  })
  loggedCalories!: number;
  @ApiProperty({ description: 'Entries with no calories yet' })
  unknownCalorieEntries!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Calories of the saved plan for the day; null when it is empty',
  })
  plannedCalories!: number | null;
}

export class MealLogSummaryDto {
  @ApiProperty({ description: 'Days up to today with at least one entry' })
  loggedDays!: number;
  @ApiProperty({
    description:
      'Days before today with entries whose calories are all known; the average uses only these',
  })
  completeDays!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Average loggedCalories over completeDays; null when there are none',
  })
  averageCalories!: number | null;
  @ApiProperty({
    description: 'Days from today to Sunday, which the plan may still change',
  })
  remainingDays!: number;
}

export class MealLogWeekDto {
  @ApiProperty({ example: '2026-11-23' }) weekStart!: string;
  @ApiProperty({ example: '2026-11-24' }) today!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'From the nutrition profile; null when it is not filled in',
  })
  dailyCalorieTarget!: number | null;
  @ApiProperty({ type: Number, nullable: true }) dailyCalorieMin!:
    number | null;
  @ApiProperty({ type: Number, nullable: true }) dailyCalorieMax!:
    number | null;
  @ApiProperty({
    type: [MealLogDayDto],
    description: 'Seven days, Monday first',
  })
  days!: MealLogDayDto[];
  @ApiProperty({ type: MealLogSummaryDto }) summary!: MealLogSummaryDto;
}
