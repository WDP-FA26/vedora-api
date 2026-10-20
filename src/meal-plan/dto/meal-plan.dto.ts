import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { MealSection, Weekday } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const WEEKDAYS = Object.values(Weekday);
export const MEAL_SECTIONS = Object.values(MealSection);
export const MAX_DISHES_PER_SECTION = 6;

const DishIds = (description: string) =>
  applyDecorators(
    ApiProperty({
      type: [String],
      format: 'uuid',
      maxItems: MAX_DISHES_PER_SECTION,
      description,
    }),
    IsArray(),
    ArrayMaxSize(MAX_DISHES_PER_SECTION),
    ArrayUnique(),
    IsUUID('4', { each: true }),
  );

export const MEAL_PLAN_PROBLEM_CODES = [
  'UNKNOWN_RECIPE',
  'AVOIDED_INGREDIENT',
  'DAY_CONFLICT',
] as const;

/** The complete new content of one day; an empty list clears that section. */
export class SaveMealDayDto {
  @ApiProperty({ enum: Weekday })
  @IsEnum(Weekday)
  day!: Weekday;

  @DishIds('Breakfast dishes, in order')
  breakfast!: string[];

  @DishIds('Lunch dishes, in order')
  lunch!: string[];

  @DishIds('Dinner dishes, in order')
  dinner!: string[];

  @DishIds('Everything outside the three meals: snacks, drinks, desserts')
  others!: string[];
}

export class SaveMealDaysDto {
  @ApiProperty({
    type: [SaveMealDayDto],
    description: 'Only the days that change; the others stay as saved',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEEKDAYS.length)
  @ArrayUnique((day: SaveMealDayDto) => day.day)
  @ValidateNested({ each: true })
  @Type(() => SaveMealDayDto)
  days!: SaveMealDayDto[];
}

export class MealIngredientDto {
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: Number }) quantity!: number | null;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

export class MealRecipeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uri' })
  imageUrl!: string | null;
  @ApiProperty() servings!: number;
  @ApiProperty({ nullable: true, type: Number }) prepMinutes!: number | null;
  @ApiProperty({ nullable: true, type: Number }) cookMinutes!: number | null;
  @ApiProperty({ type: [MealIngredientDto] }) ingredients!: MealIngredientDto[];
  @ApiProperty({ type: [String] }) steps!: string[];
}

export class MealSectionDto {
  @ApiProperty({ enum: MealSection }) section!: MealSection;
  @ApiProperty({ type: [MealRecipeDto], description: 'In order' })
  recipes!: MealRecipeDto[];
}

export class MealDayDto {
  @ApiProperty({ enum: Weekday }) day!: Weekday;
  @ApiProperty({
    type: [MealSectionDto],
    description: 'Always the four sections: breakfast, lunch, dinner, other',
  })
  sections!: MealSectionDto[];
}

export class MealPlanProblemDto {
  @ApiProperty({ enum: MEAL_PLAN_PROBLEM_CODES })
  code!: (typeof MEAL_PLAN_PROBLEM_CODES)[number];

  @ApiProperty({ enum: Weekday }) day!: Weekday;

  @ApiProperty({
    type: [String],
    description: 'Titles of the recipes involved',
  })
  recipes!: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'IDs of the recipes involved, including missing IDs for UNKNOWN_RECIPE',
  })
  recipeIds!: string[];

  @ApiProperty({
    type: [String],
    description: 'The avoided ingredients, or the two that clash',
  })
  ingredients!: string[];

  @ApiProperty({ nullable: true, type: String, description: 'Why they clash' })
  reason!: string | null;
}

export class MealPlanDto {
  @ApiProperty({
    type: [MealDayDto],
    description: 'All seven days, Monday first',
  })
  days!: MealDayDto[];

  @ApiProperty({
    type: [MealPlanProblemDto],
    description:
      'What is wrong with the saved timetable now, e.g. after the user or an admin changed a rule',
  })
  problems!: MealPlanProblemDto[];
}

export class MealRecipeRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
}

export class MealPlanPreviewSectionDto {
  @ApiProperty({ enum: MealSection }) section!: MealSection;
  @ApiProperty({ type: [MealRecipeRefDto] }) recipes!: MealRecipeRefDto[];
  @ApiProperty({ type: [MealRecipeRefDto] }) previous!: MealRecipeRefDto[];
}

export class MealPlanPreviewDayDto {
  @ApiProperty({ enum: Weekday }) day!: Weekday;
  @ApiProperty({ type: [MealPlanPreviewSectionDto] })
  sections!: MealPlanPreviewSectionDto[];
}

export class MealPlanPreviewDto {
  @ApiProperty({ type: [MealPlanPreviewDayDto] })
  days!: MealPlanPreviewDayDto[];
  @ApiProperty({ type: [MealPlanProblemDto] }) problems!: MealPlanProblemDto[];
}

const MAX_PLANNER_MESSAGES = 10;
const MAX_PLANNER_MESSAGE_LENGTH = 4000;

export class PlannerMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty({ maxLength: MAX_PLANNER_MESSAGE_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PLANNER_MESSAGE_LENGTH)
  text!: string;
}

export class MealPlannerChatDto {
  @ApiProperty({
    type: [PlannerMessageDto],
    maxItems: MAX_PLANNER_MESSAGES,
    description: 'The latest turns, oldest first, ending with the user',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PLANNER_MESSAGES)
  @ValidateNested({ each: true })
  @Type(() => PlannerMessageDto)
  messages!: PlannerMessageDto[];
}
