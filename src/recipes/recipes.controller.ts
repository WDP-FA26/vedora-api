import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { OptionalAuthenticatedRequest } from '../auth/auth.types';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../common/pagination';
import {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
  RecipeCatalogQueryDto,
} from './dto/recipe-catalog.dto';
import { RecipeCatalogService } from './recipe-catalog.service';

@ApiTags('recipes')
@UseGuards(OptionalJwtAuthGuard)
@Controller('recipes')
export class RecipesController {
  constructor(private readonly catalog: RecipeCatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'Browse and search the recipe catalog',
    description: 'Public read. suitableForMe=true requires an account token.',
    security: [{}, { bearer: [] }],
  })
  @ApiPaginatedResponse(CatalogRecipeDto)
  @ApiUnauthorizedResponse({
    description: 'Invalid token or anonymous suitableForMe filter',
  })
  list(
    @Query() query: RecipeCatalogQueryDto,
    @Req() request: OptionalAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaginatedResponseDto<CatalogRecipeDto>> {
    if (query.suitableForMe)
      response.setHeader('Cache-Control', 'private, no-store');
    return this.catalog.list(query, request.user?.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a recipe, ingredients, steps and conflict warnings',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: CatalogRecipeDetailDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogRecipeDetailDto> {
    return this.catalog.findOne(id);
  }
}
