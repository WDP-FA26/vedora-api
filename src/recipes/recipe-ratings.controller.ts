import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import {
  MyRecipeRatingDto,
  RecipeRatingSummaryDto,
  SetRecipeRatingDto,
} from './dto/recipe-rating.dto.js';
import { RecipeRatingsService } from './recipe-ratings.service.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('recipe-ratings')
@ApiNotFoundResponse({ type: ErrorBodyDto, description: 'Recipe not found' })
@Controller('recipes/:recipeId')
export class RecipeRatingsController {
  constructor(private readonly ratings: RecipeRatingsService) {}

  @Get('ratings/summary')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiUnauthorizedResponse({
    type: ErrorBodyDto,
    description: 'A supplied token is invalid or expired',
  })
  @ApiOperation({
    summary: 'Read a recipe rating count and mean; no voter identities',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: RecipeRatingSummaryDto })
  summary(
    @Param('recipeId', ParseUUIDPipe) recipeId: string,
  ): Promise<RecipeRatingSummaryDto> {
    return this.ratings.summary(recipeId);
  }

  @Get('rating')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ type: ErrorBodyDto })
  @ApiOperation({ summary: 'Read your own score and the current summary' })
  @ApiOkResponse({ type: MyRecipeRatingDto })
  mine(
    @Param('recipeId', ParseUUIDPipe) recipeId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MyRecipeRatingDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.ratings.mine(recipeId, request.user.sub);
  }

  @Put('rating')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ type: ErrorBodyDto })
  @ApiForbiddenResponse({
    type: ErrorBodyDto,
    description: 'SELF_RATING_NOT_ALLOWED or EMAIL_NOT_VERIFIED',
  })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'RATING_CONFLICT; reload before retrying',
  })
  @ApiOperation({ summary: 'Set your integer score from 1 to 5 (idempotent)' })
  @ApiOkResponse({ type: MyRecipeRatingDto })
  set(
    @Param('recipeId', ParseUUIDPipe) recipeId: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: SetRecipeRatingDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MyRecipeRatingDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.ratings.set(recipeId, request.user.sub, dto.value);
  }

  @Delete('rating')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'RATING_CONFLICT; reload before retrying',
  })
  @ApiOperation({
    summary: 'Remove your score (idempotent), returning the new summary',
  })
  @ApiOkResponse({ type: MyRecipeRatingDto })
  remove(
    @Param('recipeId', ParseUUIDPipe) recipeId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MyRecipeRatingDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.ratings.set(recipeId, request.user.sub, null);
  }
}
