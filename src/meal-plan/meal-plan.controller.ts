import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserThrottlerGuard } from '../nutrition-chat/user-throttler.guard';
import {
  MealPlanDto,
  MealPlanPreviewDto,
  MealPlannerChatDto,
  SaveMealDaysDto,
} from './dto/meal-plan.dto';
import { MealPlanService } from './meal-plan.service';
import { MealPlannerChatService } from './meal-planner-chat.service';

@ApiTags('meal-plan')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@UseGuards(JwtAuthGuard)
@Controller('meal-plan')
export class MealPlanController {
  constructor(
    private readonly mealPlan: MealPlanService,
    private readonly chatService: MealPlannerChatService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get your weekly timetable' })
  @ApiOkResponse({ type: MealPlanDto })
  find(@Req() request: AuthenticatedRequest): Promise<MealPlanDto> {
    return this.mealPlan.find(request.user.sub);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a manual change without saving',
    description:
      'Returns previous and proposed dishes and any unknown recipe, avoided ingredient or same-day conflict. Save a valid proposal with PUT /meal-plan/days.',
  })
  @ApiOkResponse({ type: MealPlanPreviewDto })
  preview(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveMealDaysDto,
  ): Promise<MealPlanPreviewDto> {
    return this.mealPlan.preview(request.user.sub, dto.days);
  }

  @Put('days')
  @ApiOperation({
    summary: 'Replace the dishes of some days of your timetable',
    description:
      'All or nothing. Refused when a day that gains a dish would hold an ingredient you avoid or two incompatible ingredients.',
  })
  @ApiOkResponse({ type: MealPlanDto })
  @ApiConflictResponse({
    description:
      '`MEAL_PLAN_INVALID` with problems, or `MEAL_PLAN_CONFLICT`: preview again before retrying',
  })
  apply(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveMealDaysDto,
  ): Promise<MealPlanDto> {
    return this.mealPlan.apply(request.user.sub, dto.days);
  }

  @Post('chat')
  @UseGuards(UserThrottlerGuard)
  @ApiOperation({
    summary: 'Talk to the assistant: meal planning and nutrition questions',
    description:
      'Streams the reply as an AI SDK UI message stream (SSE) for `useChat`. Its `proposeMealPlan` tool output is a checked proposal; save it with `PUT /meal-plan/days`.',
  })
  @ApiTooManyRequestsResponse({ description: 'More than 10 messages a minute' })
  @ApiServiceUnavailableResponse({
    description: 'The moderation model failed or timed out',
  })
  async chat(
    @Req() request: AuthenticatedRequest,
    @Body() dto: MealPlannerChatDto,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    response.on('close', () => abort.abort());

    await pipeUIMessageStreamToResponse({
      response,
      stream: await this.chatService.stream(
        request.user.sub,
        dto.messages,
        abort.signal,
      ),
    });
  }
}
