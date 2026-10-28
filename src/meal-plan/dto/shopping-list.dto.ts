import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MealSection, Weekday } from '../../mongo/models.js';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
} from 'class-validator';
import { WEEKDAYS } from './meal-plan.dto.js';

export class ShoppingListQueryDto {
  @ApiPropertyOptional({
    enum: Weekday,
    isArray: true,
    example: ['MON', 'TUE'],
    description:
      'Comma-separated days or repeated days parameters; defaults to all seven days',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.split(',').map((day) => day.trim())
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsEnum(Weekday, { each: true })
  days: Weekday[] = [...WEEKDAYS];
}

export class ShoppingContributionDto {
  @ApiProperty({ format: 'uuid' }) recipeId!: string;
  @ApiProperty() recipeTitle!: string;
  @ApiProperty({ enum: Weekday }) day!: Weekday;
  @ApiProperty({ enum: MealSection }) section!: MealSection;
  @ApiProperty({
    description:
      'Original recipe yield; quantities are not divided by servings',
  })
  servings!: number;
  @ApiProperty({ type: String, nullable: true, example: '100.25' }) quantity!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class ShoppingListItemDto {
  @ApiProperty({ format: 'uuid' }) ingredientId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) unit!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Sum of known quantities, in decimal text; null if all contributions are unknown. May be partial when hasUnknownQuantity=true.',
  })
  knownQuantity!: string | null;
  @ApiProperty() hasUnknownQuantity!: boolean;
  @ApiProperty({ type: [ShoppingContributionDto] })
  contributions!: ShoppingContributionDto[];
}

export class ShoppingListDto {
  @ApiProperty({ enum: Weekday, isArray: true }) days!: Weekday[];
  @ApiProperty({
    enum: ['RECIPE_PER_OCCURRENCE'],
    description:
      'Each scheduled occurrence contributes its full original recipe quantities, without per-person scaling',
  })
  quantityBasis!: 'RECIPE_PER_OCCURRENCE';
  @ApiProperty({ type: [ShoppingListItemDto] }) items!: ShoppingListItemDto[];
}
