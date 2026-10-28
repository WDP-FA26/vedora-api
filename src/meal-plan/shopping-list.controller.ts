import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  ShoppingListDto,
  ShoppingListQueryDto,
} from './dto/shopping-list.dto.js';
import { ShoppingListService } from './shopping-list.service.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('meal-plan')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorBodyDto })
@UseGuards(JwtAuthGuard)
@Controller('meal-plan/shopping-list')
export class ShoppingListController {
  constructor(private readonly shopping: ShoppingListService) {}

  @Get()
  @ApiOperation({
    summary: 'Aggregate your saved timetable ingredients for selected weekdays',
    description:
      'Read-only. Adds full original recipe quantities once per day/section occurrence, grouping by ingredient ID and exact unit; unknown quantities remain explicit.',
  })
  @ApiOkResponse({ type: ShoppingListDto })
  get(
    @Req() request: AuthenticatedRequest,
    @Query() query: ShoppingListQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShoppingListDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.shopping.get(request.user.sub, query);
  }
}
