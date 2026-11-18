import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaymentStatus } from '../../mongo/models.js';
import {
  PAID_PLANS,
  type PaidPlan,
} from '../../subscriptions/subscription-policy.js';
import { DashboardQueryDto } from '../../admin-dashboard/dto/dashboard.dto.js';

export class AdminPaymentQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;
  @ApiPropertyOptional({ enum: PAID_PLANS })
  @IsOptional()
  @IsIn(PAID_PLANS)
  plan?: PaidPlan;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
  @ApiPropertyOptional({
    description:
      'Exact invoice, code, order/user ID, provider transaction, username or email (case insensitive)',
    maxLength: runtimeConfig.ADMIN_PAYMENT_SEARCH_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.ADMIN_PAYMENT_SEARCH_MAX_LENGTH)
  q?: string;
}
export class AdminPaymentPageDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_PAGE)
  page = 1;
  @ApiPropertyOptional({
    default: runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT,
    maximum: runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT)
  limit = runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT;
}
export class AdminPaymentListDto extends AdminPaymentQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_PAGE)
  page = 1;
  @ApiPropertyOptional({
    default: runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT,
    maximum: runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT)
  limit = runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT;
}
export class AdminReceiptQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  intentId?: string;
  @ApiPropertyOptional({
    maxLength: runtimeConfig.ADMIN_RECEIPT_CODE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.ADMIN_RECEIPT_CODE_MAX_LENGTH)
  outcome?: string;
  @ApiPropertyOptional({
    maxLength: runtimeConfig.ADMIN_RECEIPT_REFERENCE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.ADMIN_RECEIPT_REFERENCE_MAX_LENGTH)
  transactionId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  unmatched?: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_PAGE)
  page = 1;
  @ApiPropertyOptional({
    default: runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT,
    maximum: runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(runtimeConfig.ADMIN_PAGINATION_MAX_LIMIT)
  limit = runtimeConfig.ADMIN_PAGINATION_DEFAULT_LIMIT;
}
export class AdminSubscriptionQueryDto extends AdminPaymentPageDto {
  @ApiPropertyOptional({ enum: PAID_PLANS })
  @IsOptional()
  @IsIn(PAID_PLANS)
  plan?: PaidPlan;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
