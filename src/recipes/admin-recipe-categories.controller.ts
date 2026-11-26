import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../mongo/models.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import {
  RecipeCategoryDto,
  SaveRecipeCategoryDto,
} from './dto/recipe-category.dto.js';
import { RecipeCategoriesService } from './recipe-categories.service.js';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'Insufficient account permissions',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/recipe-categories')
export class AdminRecipeCategoriesController {
  constructor(private readonly categories: RecipeCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List recipe categories by sort order' })
  @ApiPaginatedResponse(RecipeCategoryDto)
  findAll(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<RecipeCategoryDto>> {
    return this.categories.findAll(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a recipe category' })
  @ApiOkResponse({ type: RecipeCategoryDto })
  @ApiConflictResponse({ type: ErrorBodyDto, description: '`NAME_TAKEN`' })
  create(@Body() dto: SaveRecipeCategoryDto): Promise<RecipeCategoryDto> {
    return this.categories.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a recipe category' })
  @ApiOkResponse({ type: RecipeCategoryDto })
  @ApiConflictResponse({ type: ErrorBodyDto, description: '`NAME_TAKEN`' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveRecipeCategoryDto,
  ): Promise<RecipeCategoryDto> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a recipe category' })
  @ApiNoContentResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.categories.remove(id);
  }
}
