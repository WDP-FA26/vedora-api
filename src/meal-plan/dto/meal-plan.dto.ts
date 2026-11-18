import { runtimeConfig } from '../../config/runtime-config.js';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type MealPlanChatProposalStatus,
  MealSection,
  RecipeTag,
  Weekday,
} from '../../mongo/models.js';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LastMessageFromUser } from '../../ai/guardrails/conversation-state.js';

export const WEEKDAYS = Object.values(Weekday);
export const MEAL_SECTIONS = Object.values(MealSection);
export const MAX_DISHES_PER_SECTION =
  runtimeConfig.MEAL_PLAN_MAX_DISHES_PER_SECTION;

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

export const MAX_GENERATE_MINUTES = 240;
export const MAX_GENERATE_QUERY_LENGTH =
  runtimeConfig.RECIPE_CATALOG_QUERY_MAX_LENGTH;
export const MAX_GENERATE_EXCLUDES = 10;

export const MAX_GENERATE_IDS = 200;

export class SlotRefDto {
  @ApiProperty({ enum: Weekday })
  @IsEnum(Weekday)
  day!: Weekday;

  @ApiProperty({ enum: MealSection })
  @IsEnum(MealSection)
  section!: MealSection;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_DISHES_PER_SECTION,
    description:
      'Optional recipes to place in this pinned slot before filling the rest',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DISHES_PER_SECTION)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  recipeIds?: string[];
}

export class GenerateMealDaysDto {
  @ApiProperty({
    enum: Weekday,
    isArray: true,
    description: 'Days to fill',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(Weekday, { each: true })
  days!: Weekday[];

  @ApiProperty({
    enum: MealSection,
    isArray: true,
    description: 'Sections to fill with one dish each',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(MealSection, { each: true })
  sections!: MealSection[];

  @ApiProperty({
    description:
      'true keeps every slot that already has a dish; false replaces the chosen sections',
  })
  @IsBoolean()
  onlyEmpty!: boolean;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_GENERATE_MINUTES,
    description: 'Longest total time (prep + cook) of a dish',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_GENERATE_MINUTES)
  maxMinutes?: number;

  @ApiPropertyOptional({
    maxLength: MAX_GENERATE_QUERY_LENGTH,
    description:
      'A dish or ingredient to prefer, e.g. "đậu hũ". Only a preference: dishes without it can still be chosen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_GENERATE_QUERY_LENGTH)
  query?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_GENERATE_EXCLUDES,
    description:
      'Words a dish must not have in its title or ingredients, e.g. "chiên". Unlike `query` this is a hard filter',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GENERATE_EXCLUDES)
  @IsString({ each: true })
  @MaxLength(MAX_GENERATE_QUERY_LENGTH, { each: true })
  exclude?: string[];

  @ApiPropertyOptional({
    enum: RecipeTag,
    isArray: true,
    description:
      'Only choose dishes with one of these tags. Untagged dishes are left out when set',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(RecipeTag, { each: true })
  tags?: RecipeTag[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_DISHES_PER_SECTION,
    default: 1,
    description: 'Dishes per filled slot',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DISHES_PER_SECTION)
  perSection?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_GENERATE_IDS,
    description:
      'Only choose from these recipes, e.g. a shortlist built from a search. Still subject to every other rule',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GENERATE_IDS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  candidateIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_GENERATE_IDS,
    description: 'Never choose these recipes',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GENERATE_IDS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  avoidIds?: string[];

  @ApiPropertyOptional({
    type: [SlotRefDto],
    description: 'Slots to leave exactly as they are, whatever else is set',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlotRefDto)
  pinned?: SlotRefDto[];
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
  @ApiProperty({ enum: RecipeTag, nullable: true })
  tag!: RecipeTag | null;
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
  @ApiProperty({ enum: RecipeTag, nullable: true })
  tag!: RecipeTag | null;
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

export class MealPlanDraftDto extends MealPlanPreviewDto {
  @ApiProperty({
    description:
      'true when the draft has changes and passes every check, so it can be shown and saved',
  })
  ok!: boolean;
}

export class GenerateMealResultDto extends MealPlanDraftDto {
  @ApiProperty({ description: 'Slots this call filled or changed' })
  filled!: number;
}

const MAX_PLANNER_MESSAGES = runtimeConfig.PLANNER_CHAT_MAX_MESSAGES;
const MAX_PLANNER_MESSAGE_LENGTH =
  runtimeConfig.PLANNER_CHAT_MAX_MESSAGE_LENGTH;

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
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Chat thread ID to load/save conversation history',
  })
  @IsOptional()
  @IsUUID('4')
  threadId?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Stable logical user-turn ID for quota/idempotency',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  requestId?: string;
  @ApiProperty({
    type: [PlannerMessageDto],
    maxItems: MAX_PLANNER_MESSAGES,
    description: 'The latest turns, oldest first, ending with the user',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PLANNER_MESSAGES)
  @LastMessageFromUser()
  @ValidateNested({ each: true })
  @Type(() => PlannerMessageDto)
  messages!: PlannerMessageDto[];
}

export const MAX_CHAT_THREAD_TITLE_LENGTH = 120;
export const MAX_STORED_MESSAGE_TEXT_LENGTH = 20000;
export const MAX_STORED_MESSAGE_PARTS = 100;
export const MAX_SYNC_MESSAGES = 200;

export class MealPlanChatThreadSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() messageCount!: number;
  @ApiProperty({ nullable: true, type: String })
  lastMessagePreview!: string | null;
  @ApiProperty({ type: Date }) lastMessageAt!: Date;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ type: Date }) updatedAt!: Date;
}

export class MealPlanChatMessageDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['user', 'assistant'] }) role!: 'user' | 'assistant';
  @ApiProperty() text!: string;
  @ApiProperty({ type: [Object] }) parts!: Record<string, unknown>[];
  @ApiPropertyOptional({ nullable: true, type: Object })
  metadata!: { refused?: boolean } | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class MealPlanChatThreadDetailDto extends MealPlanChatThreadSummaryDto {
  @ApiProperty({
    type: Object,
    description: 'Proposal status map keyed by proposal/toolCall ID',
  })
  proposalStatuses!: Record<string, MealPlanChatProposalStatus>;

  @ApiProperty({ type: [MealPlanChatMessageDto] })
  messages!: MealPlanChatMessageDto[];
}

export class CreateMealPlanChatThreadDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @ApiPropertyOptional({ maxLength: MAX_CHAT_THREAD_TITLE_LENGTH })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CHAT_THREAD_TITLE_LENGTH)
  title?: string;
}

export class SyncMealPlanChatMessageDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  id!: string;

  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiPropertyOptional({ maxLength: MAX_STORED_MESSAGE_TEXT_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_STORED_MESSAGE_TEXT_LENGTH)
  text?: string;

  @ApiPropertyOptional({ type: [Object], maxItems: MAX_STORED_MESSAGE_PARTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STORED_MESSAGE_PARTS)
  @IsObject({ each: true })
  parts?: Record<string, unknown>[];

  @ApiPropertyOptional({ nullable: true, type: Object })
  @IsOptional()
  @IsObject()
  metadata?: { refused?: boolean } | null;
}

export class UpdateMealPlanChatThreadDto {
  @ApiPropertyOptional({ maxLength: MAX_CHAT_THREAD_TITLE_LENGTH })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CHAT_THREAD_TITLE_LENGTH)
  title?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  proposalStatuses?: Record<string, MealPlanChatProposalStatus>;

  @ApiPropertyOptional({
    type: [SyncMealPlanChatMessageDto],
    maxItems: MAX_SYNC_MESSAGES,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SYNC_MESSAGES)
  @ValidateNested({ each: true })
  @Type(() => SyncMealPlanChatMessageDto)
  messages?: SyncMealPlanChatMessageDto[];
}
