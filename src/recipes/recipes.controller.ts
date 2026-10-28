import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { OptionalAuthenticatedRequest } from '../auth/auth.types.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
  RecipeCatalogQueryDto,
} from './dto/recipe-catalog.dto.js';
import { RecipeCatalogService } from './recipe-catalog.service.js';
import { RecipeFavoritesService } from './recipe-favorites.service.js';
import {
  FavoriteRecipeDto,
  RecipeFavoriteBodyDto,
  RecipeFavoriteStateDto,
} from './dto/recipe-favorite.dto.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('recipes')
@UseGuards(OptionalJwtAuthGuard)
@Controller('recipes')
export class RecipesController {
  constructor(
    private readonly catalog: RecipeCatalogService,
    private readonly favorites: RecipeFavoritesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Browse and search the recipe catalog',
    description: 'Public read. suitableForMe=true requires an account token.',
    security: [{}, { bearer: [] }],
  })
  @ApiPaginatedResponse(CatalogRecipeDto)
  @ApiUnauthorizedResponse({
    type: ErrorBodyDto,
    description: 'Invalid token or anonymous suitableForMe filter',
  })
  list(
    @Query() query: RecipeCatalogQueryDto,
    @Req() request: OptionalAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaginatedResponseDto<CatalogRecipeDto>> {
    response.vary('Authorization');
    if (request.user) response.setHeader('Cache-Control', 'private, no-store');
    return this.catalog.list(query, request.user?.sub);
  }

  @Get('favorites')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List your saved recipes, newest saved first' })
  @ApiPaginatedResponse(FavoriteRecipeDto)
  favoritesList(
    @Query() query: PaginationQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaginatedResponseDto<FavoriteRecipeDto>> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.favorites.list(request.user.sub, query);
  }

  @Put(':id/favorite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save a recipe (idempotent)' })
  @ApiOkResponse({ type: RecipeFavoriteStateDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({ type: ErrorBodyDto, description: 'FAVORITE_CONFLICT' })
  saveFavorite(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: RecipeFavoriteBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecipeFavoriteStateDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.favorites.set(id, request.user.sub, true);
  }

  @Delete(':id/favorite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove your saved recipe (idempotent)' })
  @ApiOkResponse({ type: RecipeFavoriteStateDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({ type: ErrorBodyDto, description: 'FAVORITE_CONFLICT' })
  removeFavorite(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: RecipeFavoriteBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecipeFavoriteStateDto> {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.favorites.set(id, request.user.sub, false);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a recipe, ingredients, steps and conflict warnings',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: CatalogRecipeDetailDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: OptionalAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CatalogRecipeDetailDto> {
    response.vary('Authorization');
    if (request.user) response.setHeader('Cache-Control', 'private, no-store');
    return this.catalog.findOne(id, request.user?.sub);
  }
}
