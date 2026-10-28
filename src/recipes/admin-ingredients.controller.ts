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
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../mongo/models';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import {
  IncompatibilityRuleDto,
  IngredientDto,
  IngredientGroupDto,
  SaveIncompatibilityRuleDto,
  SaveIngredientDto,
  SaveIngredientGroupDto,
} from './dto/ingredient.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { IngredientsService } from './ingredients.service';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/ingredients')
export class AdminIngredientsController {
  constructor(private readonly ingredients: IngredientsService) {}

  @Get()
  @ApiOperation({ summary: 'List ingredients by name' })
  @ApiPaginatedResponse(IngredientDto)
  findAll(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IngredientDto>> {
    return this.ingredients.findAll(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an ingredient' })
  @ApiOkResponse({ type: IngredientDto })
  create(@Body() dto: SaveIngredientDto): Promise<IngredientDto> {
    return this.ingredients.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace an ingredient' })
  @ApiOkResponse({ type: IngredientDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveIngredientDto,
  ): Promise<IngredientDto> {
    return this.ingredients.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an ingredient',
    description: 'Answers 409 `INGREDIENT_IN_USE` while a recipe uses it.',
  })
  @ApiNoContentResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.ingredients.remove(id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/ingredient-groups')
export class AdminIngredientGroupsController {
  constructor(private readonly ingredients: IngredientsService) {}

  @Get()
  @ApiOperation({ summary: 'List ingredient groups by name' })
  @ApiPaginatedResponse(IngredientGroupDto)
  findAll(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IngredientGroupDto>> {
    return this.ingredients.findAllGroups(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an ingredient group' })
  @ApiOkResponse({ type: IngredientGroupDto })
  create(@Body() dto: SaveIngredientGroupDto): Promise<IngredientGroupDto> {
    return this.ingredients.createGroup(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace an ingredient group' })
  @ApiOkResponse({ type: IngredientGroupDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveIngredientGroupDto,
  ): Promise<IngredientGroupDto> {
    return this.ingredients.updateGroup(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an ingredient group',
    description: 'Its incompatibility rules go with it.',
  })
  @ApiNoContentResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.ingredients.removeGroup(id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/incompatibility-rules')
export class AdminIncompatibilityRulesController {
  constructor(private readonly rules: IncompatibilityRulesService) {}

  @Get()
  @ApiOperation({ summary: 'List incompatibility rules, newest first' })
  @ApiPaginatedResponse(IncompatibilityRuleDto)
  findAll(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IncompatibilityRuleDto>> {
    return this.rules.findAll(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an incompatibility rule' })
  @ApiOkResponse({ type: IncompatibilityRuleDto })
  create(
    @Body() dto: SaveIncompatibilityRuleDto,
  ): Promise<IncompatibilityRuleDto> {
    return this.rules.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace an incompatibility rule' })
  @ApiOkResponse({ type: IncompatibilityRuleDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveIncompatibilityRuleDto,
  ): Promise<IncompatibilityRuleDto> {
    return this.rules.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an incompatibility rule' })
  @ApiNoContentResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.rules.remove(id);
  }
}
