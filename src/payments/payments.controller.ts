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
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PaymentWebhookReceipt, UserRole } from '../mongo/models.js';
import {
  BillingCatalogDto,
  BillingOverviewDto,
  CreatePaymentDto,
  PaymentDto,
} from './payment.dto.js';
import { PaymentsService } from './payments.service.js';
import { SePayWebhookGuard } from './sepay-webhook.guard.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('billing')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Verified ACTIVE account required',
})
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
    type: ErrorBodyDto,
    description: 'Invalid plan, key or unsupported amount field',
  })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'Key/body conflict or a different pending purchase exists',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description:
      'Payments disabled or temporary payment-code allocation exhaustion; retain Idempotency-Key when retrying',
  })
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
    type: ErrorBodyDto,
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
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'Completed payment cannot be cancelled',
  })
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
@Roles(UserRole.ADMIN)
@Controller('admin/payments')
export class PaymentReconciliationController {
  constructor(
    @InjectModel(PaymentWebhookReceipt.name)
    private readonly webhookReceipts: Model<PaymentWebhookReceipt>,
  ) {}

  @Get('webhook-receipts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Latest 50 sanitized webhook outcomes for reconciliation (admin only)',
  })
  async receipts() {
    const rows = await this.webhookReceipts
      .find()
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .exec();
    return rows.map(
      ({
        id,
        providerTransactionId,
        payloadHash,
        outcome,
        intentId,
        createdAt,
      }) => ({
        id,
        providerTransactionId,
        payloadHash,
        outcome,
        intentId,
        createdAt,
      }),
    );
  }
}
