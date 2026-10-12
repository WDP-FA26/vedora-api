import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DietaryService } from './dietary.service';
import {
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  SaveDietaryRestrictionsDto,
  PatchDietaryProfileDto,
} from './dto/dietary.dto';

@ApiTags('dietary')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@UseGuards(JwtAuthGuard)
@Controller('dietary')
export class DietaryController {
  constructor(private readonly dietary: DietaryService) {}

  @Get('options')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List the ingredients and groups a user can avoid' })
  @ApiOkResponse({ type: DietaryOptionsDto })
  options(): Promise<DietaryOptionsDto> {
    return this.dietary.options();
  }

  @Get('me')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get what you do not eat' })
  @ApiOkResponse({ type: DietaryRestrictionsDto })
  find(@Req() request: AuthenticatedRequest): Promise<DietaryRestrictionsDto> {
    return this.dietary.find(request.user.sub);
  }

  @Put('me')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Replace what you do not eat' })
  @ApiOkResponse({ type: DietaryRestrictionsDto })
  replace(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveDietaryRestrictionsDto,
  ): Promise<DietaryRestrictionsDto> {
    return this.dietary.replace(request.user.sub, dto);
  }

  @Patch('me')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Update your dietary profile with optimistic version checking',
  })
  @ApiOkResponse({ type: DietaryRestrictionsDto })
  @ApiBadRequestResponse({
    description:
      'Invalid target, inconsistent allergy acknowledgement, conflicting preference or empty update',
  })
  @ApiConflictResponse({
    description: 'VERSION_CONFLICT: reload the current profile before saving',
  })
  patch(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PatchDietaryProfileDto,
  ): Promise<DietaryRestrictionsDto> {
    return this.dietary.patch(request.user.sub, dto);
  }
}
