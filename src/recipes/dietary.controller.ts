import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { DietaryService } from './dietary.service.js';
import {
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  SaveDietaryRestrictionsDto,
} from './dto/dietary.dto.js';

@ApiTags('dietary')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@UseGuards(JwtAuthGuard)
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
}
