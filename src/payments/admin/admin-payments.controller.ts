import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { RolesGuard } from '../../auth-core/roles.guard.js';
import { Roles } from '../../auth-core/roles.decorator.js';
import { UserRole } from '../../mongo/models.js';
import { AdminPaymentsService } from './admin-payments.service.js';
import {
  AdminPaymentListDto,
  AdminPaymentPageDto,
  AdminPaymentQueryDto,
  AdminReceiptQueryDto,
  AdminSubscriptionQueryDto,
} from './admin-payment-query.dto.js';

@ApiTags('billing-admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: AdminPaymentsService) {}
  @Get('overview')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Created-order metrics, captured VND revenue, global active verified-account membership snapshot',
  })
  overview(@Query() query: AdminPaymentQueryDto) {
    return this.payments.overview(query);
  }
  @Get('orders')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Paginated orders by creation date and exact search; legacy plan names preserved',
  })
  orders(@Query() query: AdminPaymentListDto) {
    return this.payments.orders(query);
  }
  @Get('orders/:id')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Read-only order snapshot, current membership and sanitized webhook outcomes',
  })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.detail(id);
  }
  @Get('orders/:id/receipts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'All-time receipt history for an order, paginated; no raw provider payload',
  })
  orderReceipts(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminPaymentPageDto,
  ) {
    return this.payments.orderReceipts(id, query);
  }
  @Get('receipts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Paginated webhook outcomes including unmatched callbacks; Bangkok date range',
  })
  receipts(@Query() query: AdminReceiptQueryDto) {
    return this.payments.receiptsPage(query);
  }
  @Get('subscriptions')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Current Plus/Pro among active verified accounts; latest successful purchase replaces earlier cycles',
  })
  subscriptions(@Query() query: AdminSubscriptionQueryDto) {
    return this.payments.activeSubscriptions(query);
  }
  @Get('export')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'Export up to 10000 orders matching creation-date filters; exact VND integers and formula-escaped text',
  })
  async export(
    @Query() query: AdminPaymentQueryDto,
    @Res() response: Response,
  ) {
    const csv = await this.payments.export(query);
    response.type('text/csv').attachment('vedora-payments.csv').send(csv);
  }
}
