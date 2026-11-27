import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BillingPlan } from '../mongo/models.js';
import { UsersQueryDto } from '../users/dto/users-query.dto.js';
import { PAID_PLANS } from './subscription-policy.js';

export class SubscriptionUserQueryDto extends UsersQueryDto {}

export class CreateSubscriptionGrantDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;
  @ApiProperty({ enum: PAID_PLANS })
  @IsIn(PAID_PLANS)
  planCode!: BillingPlan.PLUS | BillingPlan.PRO;
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  catalogVersion!: number;
  @ApiProperty({
    description:
      'Current period key from the selected user detail; prevents replacing a changed membership',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  expectedPeriodKey!: string;
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
