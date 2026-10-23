import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillingPlan, PaymentStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({ enum: BillingPlan })
  @IsEnum(BillingPlan)
  planCode!: BillingPlan;
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
  @ApiProperty({ enum: BillingPlan }) planCode!: BillingPlan;
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
  @ApiProperty({ enum: BillingPlan }) code!: BillingPlan;
  @ApiProperty() name!: string;
  @ApiProperty({ example: '49000' }) priceVnd!: string;
  @ApiProperty() durationDays!: number;
}

export class BillingCatalogDto {
  @ApiProperty() paymentsEnabled!: boolean;
  @ApiProperty({ type: [BillingPlanDto] }) plans!: BillingPlanDto[];
}

export class MembershipDto {
  @ApiProperty({ enum: ['FREE', 'PRO', 'PREMIUM'] }) planCode!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) startsAt!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) expiresAt!:
    string | null;
}

export class BillingOverviewDto {
  @ApiProperty({ type: MembershipDto }) membership!: MembershipDto;
  @ApiPropertyOptional({ type: PaymentDto, nullable: true })
  pendingPayment!: PaymentDto | null;
  @ApiProperty({
    type: [PaymentDto],
    description: 'Most recent 20 attempts, not a complete statement',
  })
  recentPayments!: PaymentDto[];
}
