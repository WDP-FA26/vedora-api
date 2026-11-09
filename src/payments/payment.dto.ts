import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillingPlan, PaymentStatus } from '../mongo/models.js';
import { Equals, IsIn } from 'class-validator';
import {
  PAID_PLANS,
  PLAN_VERSION,
} from '../subscriptions/subscription-policy.js';

export class CreatePaymentDto {
  @ApiProperty({ enum: PAID_PLANS })
  @IsIn(PAID_PLANS)
  planCode!: BillingPlan;

  @ApiProperty({
    enum: [PLAN_VERSION],
    description: 'Required to distinguish legacy PRO from the new Pro',
  })
  @Equals(PLAN_VERSION)
  planVersion!: number;
}

export class PaymentQrDto {
  @ApiProperty() bankCode!: string;
  @ApiProperty() bankGateway!: string;
  @ApiProperty() accountNumber!: string;
  @ApiProperty() accountHolder!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty() transferContent!: string;
  @ApiProperty({ example: '49000' }) amount!: string;
  @ApiProperty({ example: 'VND' }) currency!: string;
  @ApiProperty() imageUrl!: string;
  @ApiProperty() downloadUrl!: string;
}

export class PaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PAID_PLANS }) planCode!: BillingPlan;
  @ApiProperty() planVersion!: number;
  @ApiProperty() purchasedPlanName!: string;
  @ApiProperty() textLimit!: number;
  @ApiProperty() imageLimit!: number;
  @ApiProperty() durationDays!: number;
  @ApiProperty({ example: '49000' }) amount!: string;
  @ApiProperty({ example: 'VND' }) currency!: string;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty() invoiceNumber!: string;
  @ApiProperty() paymentCode!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) paidAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) capturedAt!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) cancelledAt!:
    string | null;
  @ApiPropertyOptional({ type: PaymentQrDto, nullable: true })
  qr!: PaymentQrDto | null;
}

export class BillingPlanDto {
  @ApiProperty({ enum: PAID_PLANS }) code!: BillingPlan;
  @ApiProperty() name!: string;
  @ApiProperty({ example: '49000' }) priceVnd!: string;
  @ApiProperty() durationDays!: number;
  @ApiProperty() textLimit!: number;
  @ApiProperty() imageLimit!: number;
}

export class BillingCatalogDto {
  @ApiProperty({ enum: [PLAN_VERSION] }) planVersion!: number;
  @ApiProperty({
    type: 'object',
    properties: {
      textLimit: { type: 'number' },
      imageLimit: { type: 'number' },
    },
  })
  freeLimits!: { textLimit: number; imageLimit: number };
  @ApiProperty() paymentsEnabled!: boolean;
  @ApiProperty({ type: [BillingPlanDto] }) plans!: BillingPlanDto[];
}

export class MembershipDto {
  @ApiProperty({ enum: ['FREE', 'PLUS', 'PRO'] }) planCode!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) startsAt!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) expiresAt!:
    string | null;
}

export class SubscriptionAllowanceDto {
  @ApiProperty() used!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() remaining!: number;
  @ApiProperty() resetsAt!: Date;
  @ApiProperty({ enum: ['DAY', 'CYCLE'] }) period!: 'DAY' | 'CYCLE';
}

export class SubscriptionUsageDto {
  @ApiProperty({ type: SubscriptionAllowanceDto })
  text!: SubscriptionAllowanceDto;
  @ApiProperty({ type: SubscriptionAllowanceDto })
  images!: SubscriptionAllowanceDto;
}

export class BillingOverviewDto {
  @ApiProperty({ type: SubscriptionUsageDto }) usage!: SubscriptionUsageDto;
  @ApiProperty({ type: MembershipDto }) membership!: MembershipDto;
  @ApiPropertyOptional({ type: PaymentDto, nullable: true })
  pendingPayment!: PaymentDto | null;
  @ApiProperty({
    type: [PaymentDto],
    description: 'Most recent 20 attempts, not a complete statement',
  })
  recentPayments!: PaymentDto[];
}
