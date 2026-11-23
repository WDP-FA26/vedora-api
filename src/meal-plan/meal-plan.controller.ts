import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { UserThrottlerGuard } from '../auth-core/user-throttler.guard.js';
import {
  ApiPaginatedResponse,
  type PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import {
  CopyMealWeekDto,
  CreateMealPlanChatThreadDto,
  GenerateMealDaysDto,
  MealPlanChatThreadDetailDto,
  MealPlanChatThreadSummaryDto,
  MealPlanDraftDto,
  MealPlanDto,
  MealPlanPreviewDto,
  MealPlannerChatDto,
  SaveMealDaysDto,
  UpdateMealPlanChatThreadDto,
} from './dto/meal-plan.dto.js';
import { RequiredWeekQueryDto, WeekQueryDto } from './dto/week-start.js';
import { MealPlanService } from './meal-plan.service.js';
import { MealPlannerChatHistoryService } from './meal-planner-chat-history.service.js';
import { MealPlannerChatService } from './meal-planner-chat.service.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('meal-plan')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@UseGuards(JwtAuthGuard)
@Controller('meal-plan')
export class MealPlanController {
  constructor(
    private readonly mealPlan: MealPlanService,
    private readonly chatService: MealPlannerChatService,
    @Optional() private readonly chatHistory?: MealPlannerChatHistoryService,
  ) {}

  private requireChatHistory(): MealPlannerChatHistoryService {
    if (!this.chatHistory) {
      throw new Error('MealPlannerChatHistoryService is not configured');
    }
    return this.chatHistory;
  }

  @Get()
  @ApiOperation({
    summary: 'Get the timetable of one week',
    description:
      'A week is its Monday as `weekStart` (`YYYY-MM-DD`); the current week when left out. A week that was never planned is empty: nothing is inherited from another week. The response says which days may still change (`days[].editable`), the current week, and how far ahead and back to browse (`maxWeekStart`, `minWeekStart`).',
  })
  @ApiOkResponse({ type: MealPlanDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: '`MEAL_WEEK_OUT_OF_RANGE`: the week is too far ahead',
  })
  find(
    @Req() request: AuthenticatedRequest,
    @Query() query: WeekQueryDto,
  ): Promise<MealPlanDto> {
    return this.mealPlan.find(request.user.sub, query.weekStart);
  }

  @Post('copy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Copy the dishes of one week onto another',
    description:
      'Copies onto the days of the target week that may still change; days before today are left as they are. Refused with `MEAL_WEEK_NOT_EMPTY` when the target already has a dish on those days, unless `overwrite` is true. All or nothing, checked like `PUT /meal-plan/days`. Returns the target week.',
  })
  @ApiOkResponse({ type: MealPlanDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description:
      '`MEAL_WEEK_NOT_EMPTY`, `MEAL_WEEK_OUT_OF_RANGE`, `MEAL_DAY_LOCKED`, `MEAL_PLAN_INVALID` or `MEAL_PLAN_CONFLICT`',
  })
  copy(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CopyMealWeekDto,
  ): Promise<MealPlanDto> {
    return this.mealPlan.copyWeek(
      request.user.sub,
      dto.fromWeekStart,
      dto.toWeekStart,
      dto.overwrite ?? false,
    );
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
    return this.mealPlan.preview(request.user.sub, dto.weekStart, dto.days);
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pick dishes for chosen slots with an algorithm, without saving',
    description:
      'No AI: dishes are ranked by tag fit and the optional `query`; a dish is not repeated within one meal across the week but may appear in different meals. Avoided ingredients, over-long dishes and same-day clashes are left out. Returns the same checked preview as `POST /meal-plan/preview` (only days that change, each with all four sections); save it with `PUT /meal-plan/days`. `days` is empty when no dish fits.',
  })
  @ApiOkResponse({ type: MealPlanPreviewDto })
  generate(
    @Req() request: AuthenticatedRequest,
    @Body() dto: GenerateMealDaysDto,
  ): Promise<MealPlanPreviewDto> {
    return this.mealPlan.generate(request.user.sub, dto);
  }

  @Get('draft')
  @ApiOperation({
    summary:
      'Get the unsaved draft of one week the assistant or generator is building',
    description:
      'Same shape as `POST /meal-plan/preview` plus `ok`; each week has its own draft, and `weekStart` defaults to the current week. `days` is empty when there is no draft. Drafts expire after 6 hours and are cleared for a day when you save it.',
  })
  @ApiOkResponse({ type: MealPlanDraftDto })
  draft(
    @Req() request: AuthenticatedRequest,
    @Query() query: WeekQueryDto,
  ): Promise<MealPlanDraftDto> {
    return this.mealPlan.getDraft(request.user.sub, query.weekStart);
  }

  @Delete('draft')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Throw away the unsaved draft of one week' })
  async discardDraft(
    @Req() request: AuthenticatedRequest,
    @Query() query: RequiredWeekQueryDto,
  ): Promise<void> {
    await this.mealPlan.discardDraft(request.user.sub, query.weekStart);
  }

  @Put('days')
  @ApiOperation({
    summary: 'Replace the dishes of some days of one week',
    description:
      'All or nothing. `weekStart` is required. A day before today, or a week too far ahead, is refused (`MEAL_DAY_LOCKED`, `MEAL_WEEK_OUT_OF_RANGE`). Refused when a day that gains a dish would hold an ingredient you avoid, or a dish that does not exist. Two incompatible ingredients on one day are only a warning: the plan is saved and the clash is listed in `problems` of the response.',
  })
  @ApiOkResponse({ type: MealPlanDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description:
      '`MEAL_PLAN_INVALID` with `AVOIDED_INGREDIENT` or `UNKNOWN_RECIPE` problems, `MEAL_PLAN_CONFLICT` (preview again before retrying), `MEAL_DAY_LOCKED` or `MEAL_WEEK_OUT_OF_RANGE`',
  })
  apply(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveMealDaysDto,
  ): Promise<MealPlanDto> {
    return this.mealPlan.apply(request.user.sub, dto.weekStart, dto.days);
  }

  @Post('chat')
  @UseGuards(UserThrottlerGuard)
  @ApiOperation({
    summary: 'Talk to the assistant: meal planning and nutrition questions',
    description:
      'Streams the reply as an AI SDK UI message stream (SSE) for `useChat`. `weekStart` is the week on screen and only the default: the assistant may propose for any week from this one to `maxWeekStart`. Its `fillSlots` and `editDraft` tool outputs are checked proposals with the same shape (`weekStart`, `days`, `problems`, `ok`), each the whole draft of its week; save one with `PUT /meal-plan/days` and its own `weekStart`. Web search runs only with `allowWebSearch: true`; without it the assistant may call `requestWebSearch` (no output) to ask the user first, and web results arrive as `source-url` parts.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorBodyDto,
    description: 'More than 10 messages a minute',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
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
        dto.weekStart,
        dto.requestId,
        dto.threadId,
        { allowWebSearch: dto.allowWebSearch === true },
      ),
    });
  }

  @Get('chat/threads')
  @ApiOperation({
    summary: 'List your meal planner chat threads, newest first',
  })
  @ApiPaginatedResponse(MealPlanChatThreadSummaryDto)
  listChatThreads(
    @Req() request: AuthenticatedRequest,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<MealPlanChatThreadSummaryDto>> {
    return this.requireChatHistory().listThreads(request.user.sub, query);
  }

  @Post('chat/threads')
  @ApiOperation({ summary: 'Create or ensure a meal planner chat thread' })
  @ApiCreatedResponse({ type: MealPlanChatThreadDetailDto })
  createChatThread(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateMealPlanChatThreadDto,
  ): Promise<MealPlanChatThreadDetailDto> {
    return this.requireChatHistory().createThread(request.user.sub, dto);
  }

  @Get('chat/threads/:threadId')
  @ApiOperation({
    summary: 'Get a meal planner chat thread with all saved messages',
  })
  @ApiOkResponse({ type: MealPlanChatThreadDetailDto })
  @ApiNotFoundResponse({
    type: ErrorBodyDto,
    description: 'Chat thread not found',
  })
  getChatThread(
    @Req() request: AuthenticatedRequest,
    @Param('threadId', new ParseUUIDPipe({ version: '4' })) threadId: string,
  ): Promise<MealPlanChatThreadDetailDto> {
    return this.requireChatHistory().getThread(request.user.sub, threadId);
  }

  @Patch('chat/threads/:threadId')
  @ApiOperation({
    summary: 'Update a chat thread title, proposal statuses, or sync messages',
  })
  @ApiOkResponse({ type: MealPlanChatThreadDetailDto })
  @ApiNotFoundResponse({
    type: ErrorBodyDto,
    description: 'Chat thread not found',
  })
  updateChatThread(
    @Req() request: AuthenticatedRequest,
    @Param('threadId', new ParseUUIDPipe({ version: '4' })) threadId: string,
    @Body() dto: UpdateMealPlanChatThreadDto,
  ): Promise<MealPlanChatThreadDetailDto> {
    return this.requireChatHistory().updateThread(
      request.user.sub,
      threadId,
      dto,
    );
  }

  @Delete('chat/threads/:threadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a meal planner chat thread and its messages',
  })
  @ApiNoContentResponse({ description: 'Chat thread deleted' })
  @ApiNotFoundResponse({
    type: ErrorBodyDto,
    description: 'Chat thread not found',
  })
  deleteChatThread(
    @Req() request: AuthenticatedRequest,
    @Param('threadId', new ParseUUIDPipe({ version: '4' })) threadId: string,
  ): Promise<void> {
    return this.requireChatHistory().deleteThread(request.user.sub, threadId);
  }
}
