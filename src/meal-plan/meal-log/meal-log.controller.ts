import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { UserThrottlerGuard } from '../../auth-core/user-throttler.guard.js';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';
import {
  CalorieEstimateDto,
  CreateMealLogEntryDto,
  EstimateCaloriesDto,
  MealLogEntryDto,
  MealLogWeekDto,
  MealLogWeekQueryDto,
  UpdateMealLogEntryDto,
} from '../dto/meal-log.dto.js';
import { MealLogService } from './meal-log.service.js';

@ApiTags('meal-plan')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorBodyDto })
@UseGuards(JwtAuthGuard)
@Controller('meal-plan/log')
export class MealLogController {
  constructor(private readonly log: MealLogService) {}

  @Get()
  @ApiOperation({
    summary:
      'What you ate in one week, beside the plan and your calorie target',
    description:
      'Seven days, Monday first. Each day has its entries, the known calories eaten, how many entries have no calories yet, and the calories of the saved plan.',
  })
  @ApiOkResponse({ type: MealLogWeekDto })
  week(
    @Req() request: AuthenticatedRequest,
    @Query() query: MealLogWeekQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MealLogWeekDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.log.week(request.user.sub, query.weekStart);
  }

  @Post()
  @ApiOperation({
    summary: 'Log a dish you ate',
    description:
      'Send `recipeId` for a catalog dish (calories come from the recipe unless you send your own) or `name` for anything else (calories optional). Today or earlier only.',
  })
  @ApiCreatedResponse({ type: MealLogEntryDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto, description: 'Unknown recipe' })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'The recipe is already logged for that meal',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateMealLogEntryDto,
  ): Promise<MealLogEntryDto> {
    return this.log.create(request.user.sub, dto);
  }

  @Post('calorie-estimate')
  @UseGuards(UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask AI to look up a dish’s calories on the web',
    description:
      'Saves nothing: show the estimate and its references, then send it with `calorieSource: WEB_ESTIMATE` when logging. Uses the shared AI text allowance. `caloriesPerServing` is null when nothing reliable was found.',
  })
  @ApiOkResponse({ type: CalorieEstimateDto })
  @ApiTooManyRequestsResponse({
    type: ErrorBodyDto,
    description: 'AI_QUOTA_EXCEEDED or TOO_MANY_REQUESTS',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'The AI provider failed',
  })
  estimate(
    @Req() request: AuthenticatedRequest,
    @Body() dto: EstimateCaloriesDto,
  ): Promise<CalorieEstimateDto> {
    return this.log.estimateCalories(request.user.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a logged dish' })
  @ApiOkResponse({ type: MealLogEntryDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMealLogEntryDto,
  ): Promise<MealLogEntryDto> {
    return this.log.update(request.user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a logged dish' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.log.remove(request.user.sub, id);
  }
}
