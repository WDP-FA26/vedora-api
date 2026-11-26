import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import { RecipeCategoryDto } from './dto/recipe-category.dto.js';
import { RecipeCategoriesService } from './recipe-categories.service.js';

@ApiTags('recipes')
@Controller('recipe-categories')
export class RecipeCategoriesController {
  constructor(private readonly categories: RecipeCategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the recipe categories members browse by',
    description:
      'Public read. Hidden categories are left out; filter recipes with `GET /recipes?tag=<baseTag>`.',
    security: [{}],
  })
  @ApiPaginatedResponse(RecipeCategoryDto)
  findVisible(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<RecipeCategoryDto>> {
    return this.categories.findVisible(query);
  }
}
