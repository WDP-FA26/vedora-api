import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, Validate } from 'class-validator';
import {
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { isWeekStart } from '../meal-week.js';

@ValidatorConstraint({ name: 'isWeekStart', async: false })
class IsWeekStartConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isWeekStart(value);
  }

  defaultMessage(): string {
    return 'weekStart must be the Monday of a week, written YYYY-MM-DD';
  }
}

const WEEK_START_DESCRIPTION =
  'Monday of the week, `YYYY-MM-DD` in the app time zone (see `GET /config/public`). Not a Sunday or any other day.';

export const WeekStart = () =>
  applyDecorators(
    ApiProperty({
      type: String,
      example: '2026-11-16',
      description: WEEK_START_DESCRIPTION,
    }),
    IsString(),
    Matches(/^\d{4}-\d{2}-\d{2}$/),
    Validate(IsWeekStartConstraint),
  );

export const OptionalWeekStart = () =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      example: '2026-11-16',
      description: `${WEEK_START_DESCRIPTION} Defaults to the current week.`,
    }),
    IsOptional(),
    IsString(),
    Matches(/^\d{4}-\d{2}-\d{2}$/),
    Validate(IsWeekStartConstraint),
  );

export class WeekQueryDto {
  @OptionalWeekStart()
  weekStart?: string;
}

export class RequiredWeekQueryDto {
  @WeekStart()
  weekStart!: string;
}
