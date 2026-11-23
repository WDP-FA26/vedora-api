import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { PersonalSessionGuard } from '../auth-core/personal-session.guard.js';
import { DietaryService } from './dietary.service.js';
import {
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  NutritionProfileDto,
  SaveDietaryRestrictionsDto,
  SaveNutritionProfileDto,
  WeightCheckInDto,
} from './dto/dietary.dto.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('dietary')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'PAGE_SESSION_NOT_ALLOWED',
})
@UseGuards(JwtAuthGuard, PersonalSessionGuard)
@Controller('dietary')
export class DietaryController {
  constructor(private readonly dietary: DietaryService) {}

  @Get('options')
  @ApiOperation({ summary: 'List the ingredients and groups a user can avoid' })
  @ApiOkResponse({ type: DietaryOptionsDto })
  options(): Promise<DietaryOptionsDto> {
    return this.dietary.options();
  }

  @Get('me')
  @ApiOperation({ summary: 'Get what you do not eat' })
  @ApiOkResponse({ type: DietaryRestrictionsDto })
  find(@Req() request: AuthenticatedRequest): Promise<DietaryRestrictionsDto> {
    return this.dietary.find(request.user.sub);
  }

  @Put('me')
  @ApiOperation({ summary: 'Replace what you do not eat' })
  @ApiOkResponse({ type: DietaryRestrictionsDto })
  replace(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveDietaryRestrictionsDto,
  ): Promise<DietaryRestrictionsDto> {
    return this.dietary.replace(request.user.sub, dto);
  }

  @Get('nutrition')
  @ApiOperation({
    summary:
      'Get your body metrics, Asian BMI, TDEE target, and weight tracking history',
  })
  @ApiOkResponse({ type: NutritionProfileDto })
  findNutrition(
    @Req() request: AuthenticatedRequest,
  ): Promise<NutritionProfileDto> {
    return this.dietary.findNutrition(request.user.sub);
  }

  @Put('nutrition')
  @ApiOperation({
    summary:
      'Update your body profile, Asian BMI goal, and optional today check-in',
  })
  @ApiOkResponse({ type: NutritionProfileDto })
  saveNutrition(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveNutritionProfileDto,
  ): Promise<NutritionProfileDto> {
    return this.dietary.saveNutrition(request.user.sub, dto);
  }

  @Post('nutrition/check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log a weight and feeling check-in for BMI tracking',
  })
  @ApiOkResponse({ type: NutritionProfileDto })
  checkInWeight(
    @Req() request: AuthenticatedRequest,
    @Body() dto: WeightCheckInDto,
  ): Promise<NutritionProfileDto> {
    return this.dietary.checkInWeight(request.user.sub, dto);
  }
}
