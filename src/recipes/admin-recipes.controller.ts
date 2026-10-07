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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import {
  CheckConflictsDto,
  RecipeConflictDto,
  RecipeDetailDto,
  RecipeDto,
  SaveRecipeDto,
} from './dto/recipe.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { RecipesService } from './recipes.service';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/recipes')
export class AdminRecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly rules: IncompatibilityRulesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List recipes, most recently edited first' })
  @ApiPaginatedResponse(RecipeDto)
  findAll(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<RecipeDto>> {
    return this.recipes.findAll(query);
  }

  @Post('conflicts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Find the incompatible pairs in a set of ingredients',
    description: 'Lets the recipe editor warn before saving.',
  })
  @ApiOkResponse({ type: [RecipeConflictDto] })
  conflicts(@Body() dto: CheckConflictsDto): Promise<RecipeConflictDto[]> {
    return this.rules.findConflicts(dto.ingredientIds);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a recipe with its ingredients, steps and conflicts',
  })
  @ApiOkResponse({ type: RecipeDetailDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<RecipeDetailDto> {
    return this.recipes.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a recipe',
    description:
      'Incompatible ingredients do not block saving; they come back in `conflicts`.',
  })
  @ApiOkResponse({ type: RecipeDetailDto })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveRecipeDto,
  ): Promise<RecipeDetailDto> {
    return this.recipes.create(request.user.sub, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a recipe' })
  @ApiOkResponse({ type: RecipeDetailDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveRecipeDto,
  ): Promise<RecipeDetailDto> {
    return this.recipes.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a recipe' })
  @ApiNoContentResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.recipes.remove(id);
  }
}
