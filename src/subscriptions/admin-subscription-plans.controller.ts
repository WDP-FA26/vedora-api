import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
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
import {
  CreateSubscriptionGrantDto,
  SubscriptionUserQueryDto,
} from './subscription-grant.dto.js';
import { SubscriptionGrantsService } from './subscription-grants.service.js';

@ApiTags('admin-subscription-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiUnauthorizedResponse({ type: ErrorBodyDto })
@ApiForbiddenResponse({ type: ErrorBodyDto })
@Controller('admin/subscription-plans')
export class AdminSubscriptionPlansController {
  constructor(
    private readonly catalog: SubscriptionCatalogService,
    private readonly grants: SubscriptionGrantsService,
  ) {}

  @Get('users')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Search personal accounts eligible for an administrative subscription grant',
  })
  users(@Query() query: SubscriptionUserQueryDto) {
    return this.grants.search(query);
  }

  @Get('users/:userId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  @ApiOperation({
    summary:
      'Current membership, pending QR warning and five latest administrative grants',
  })
  user(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.grants.detail(userId);
  }

  @Post('grants')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8–200 letters, digits or . _ : -; reuse for the same retry',
  })
  @ApiOperation({
    summary:
      'Grant Plus/Pro now with a new cycle; does not create a payment or revenue',
  })
  @ApiBadRequestResponse({ type: ErrorBodyDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  grant(
    @Body() input: CreateSubscriptionGrantDto,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.grants.create(req.user.sub, input, key);
  }

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
