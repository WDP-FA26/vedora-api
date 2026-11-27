import {
  Body,
  Controller,
  Get,
  Header,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { UserRole } from '../mongo/models.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import {
  AdminSubscriptionCatalogDto,
  UpdateSubscriptionCatalogDto,
} from './subscription-catalog.dto.js';
import { SubscriptionCatalogService } from './subscription-catalog.service.js';

@ApiTags('admin-subscription-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiUnauthorizedResponse({ type: ErrorBodyDto })
@ApiForbiddenResponse({ type: ErrorBodyDto })
@Controller('admin/subscription-plans')
export class AdminSubscriptionPlansController {
  constructor(private readonly catalog: SubscriptionCatalogService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Current subscription prices and AI allowances; reads do not create settings',
  })
  @ApiOkResponse({ type: AdminSubscriptionCatalogDto })
  get(): Promise<AdminSubscriptionCatalogDto> {
    return this.catalog.current();
  }

  @Put()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Update prices and AI allowances for new purchases; existing purchase snapshots stay unchanged',
  })
  @ApiOkResponse({ type: AdminSubscriptionCatalogDto })
  @ApiBadRequestResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  update(
    @Body() input: UpdateSubscriptionCatalogDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminSubscriptionCatalogDto> {
    return this.catalog.update(input, req.user.sub);
  }
}
