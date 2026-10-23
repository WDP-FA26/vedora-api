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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  BillingCatalogDto,
  BillingOverviewDto,
  CreatePaymentDto,
  PaymentDto,
} from './payment.dto';
import { PaymentsService } from './payments.service';
import { SePayWebhookGuard } from './sepay-webhook.guard';

@ApiTags('billing')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Verified ACTIVE account required' })
@UseGuards(JwtAuthGuard)
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('billing/plans')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Server-owned Pro/Premium prices; neither plan grants privileges yet',
  })
  @ApiOkResponse({ type: BillingCatalogDto })
  plans(): BillingCatalogDto {
    return this.payments.catalog();
  }

  @Get('billing/me')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Current membership, pending purchase and latest 20 payment attempts',
  })
  @ApiOkResponse({ type: BillingOverviewDto })
  me(@Req() request: AuthenticatedRequest): Promise<BillingOverviewDto> {
    return this.payments.overview(request.user.sub);
  }

  @Post('billing/payment-intents')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8–200 letters, digits or . _ : -; retain across retries',
  })
  @ApiOperation({
    summary: 'Create/reuse a QR purchase using a server price snapshot',
  })
  @ApiOkResponse({ type: PaymentDto })
  @ApiBadRequestResponse({
    description: 'Invalid plan, key or unsupported amount field',
  })
  @ApiConflictResponse({
    description: 'Key/body conflict or a different pending purchase exists',
  })
  @ApiServiceUnavailableResponse({ description: 'SePay payments disabled' })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<PaymentDto> {
    return this.payments.create(request.user.sub, dto.planCode, key);
  }

  @Get('payment-intents/:id')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary: 'Read your payment; only server-confirmed SUCCEEDED means paid',
  })
  @ApiOkResponse({ type: PaymentDto })
  @ApiNotFoundResponse({
    description: 'Missing payment or belongs to another account',
  })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PaymentDto> {
    return this.payments.get(id, request.user.sub);
  }

  @Post('payment-intents/:id/cancel')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a pending purchase; never performs a bank refund',
  })
  @ApiOkResponse({ type: PaymentDto })
  @ApiConflictResponse({ description: 'Completed payment cannot be cancelled' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PaymentDto> {
    return this.payments.cancel(id, request.user.sub);
  }
}

@ApiTags('payments-sepay')
@Controller('payments/sepay')
export class SePayWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('bank-transfer-webhook')
  @HttpCode(200)
  @UseGuards(SePayWebhookGuard)
  @ApiHeader({
    name: 'Authorization',
    required: true,
    description: 'Apikey <SEPAY_BANK_WEBHOOK_API_KEY>; not a user JWT',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'id',
        'gateway',
        'transactionDate',
        'accountNumber',
        'transferType',
        'transferAmount',
      ],
      properties: {
        id: { type: 'integer' },
        gateway: { type: 'string' },
        transactionDate: { type: 'string', example: '2026-10-23 10:00:00' },
        accountNumber: { type: 'string' },
        subAccount: { type: 'string', nullable: true },
        code: { type: 'string', nullable: true },
        content: {
          type: 'string',
          nullable: true,
          maxLength: 4096,
          description:
            'Fallback only when code is absent/blank: exactly one complete configured-prefix code, allowing bounded ASCII spaces/tabs in its 20-hex suffix',
        },
        transferType: { type: 'string', enum: ['in', 'out'] },
        transferAmount: { type: 'integer' },
        referenceCode: { type: 'string', nullable: true },
      },
    },
  })
  @ApiOperation({
    summary:
      'Authenticated Banking callback; success=true acknowledges delivery, not necessarily capture',
  })
  async webhook(@Body() body: unknown): Promise<{ success: true }> {
    await this.payments.bankWebhook(body);
    return { success: true };
  }
}

@ApiTags('billing-admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/payments')
export class PaymentReconciliationController {
  constructor(private readonly db: PrismaService) {}

  @Get('webhook-receipts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Latest 50 sanitized webhook outcomes for reconciliation (admin only)',
  })
  receipts() {
    return this.db.paymentWebhookReceipt.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
  }
}
