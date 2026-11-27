import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsDefined,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BillingPlan } from '../mongo/enums.js';
import { BillingCatalogDto } from '../payments/payment.dto.js';
import { PAID_PLANS } from './subscription-policy.js';

export class PlanLimitsDto {
  @ApiProperty({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  textLimit!: number;

  @ApiProperty({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  imageLimit!: number;
}

export class UpdatePaidPlanDto extends PlanLimitsDto {
  @ApiProperty({ enum: PAID_PLANS })
  @IsIn(PAID_PLANS)
  code!: BillingPlan;

  @ApiProperty({ minimum: 1, maximum: 1_000_000_000 })
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  priceVnd!: number;
}

export class UpdateSubscriptionCatalogDto {
  @ApiProperty({
    minimum: 0,
    description: 'Version returned by the admin GET endpoint',
  })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  version!: number;

  @ApiProperty({ type: PlanLimitsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PlanLimitsDto)
  freeLimits!: PlanLimitsDto;

  @ApiProperty({ type: [UpdatePaidPlanDto], minItems: 2, maxItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ArrayUnique((plan: UpdatePaidPlanDto | null) => plan?.code)
  @ValidateNested({ each: true })
  @Type(() => UpdatePaidPlanDto)
  plans!: UpdatePaidPlanDto[];
}

export class AdminSubscriptionCatalogDto extends BillingCatalogDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['ENV', 'DATABASE'] }) source!: 'ENV' | 'DATABASE';
  @ApiProperty({ type: String, nullable: true }) updatedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) updatedById!: string | null;
}
