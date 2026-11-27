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
import { AccountStatus, BillingPlan, UserRole } from '../mongo/models.js';
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

export class GrantUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ enum: AccountStatus }) status!: AccountStatus;
}
export class GrantUsersPageDto {
  @ApiProperty({ type: [GrantUserDto] }) items!: GrantUserDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
export class SubscriptionGrantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: PAID_PLANS }) planCode!:
    BillingPlan.PLUS | BillingPlan.PRO;
  @ApiProperty() catalogVersion!: number;
  @ApiProperty() durationDays!: number;
  @ApiProperty() textLimit!: number;
  @ApiProperty() imageLimit!: number;
  @ApiProperty() startsAt!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() createdAt!: string;
}
export class GrantMembershipDto {
  @ApiProperty() key!: string;
  @ApiProperty({ enum: ['FREE', 'PLUS', 'PRO'] }) planCode!: string;
  @ApiProperty({ enum: ['FREE', 'PAYMENT', 'ADMIN_GRANT'] }) source!: string;
  @ApiProperty() startsAt!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() textLimit!: number;
  @ApiProperty() imageLimit!: number;
}
export class GrantPendingPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() expiresAt!: string;
}
export class GrantUserDetailDto {
  @ApiProperty({ type: GrantUserDto }) user!: GrantUserDto;
  @ApiProperty({ type: GrantMembershipDto }) membership!: GrantMembershipDto;
  @ApiProperty({ type: GrantPendingPaymentDto, nullable: true })
  pendingPayment!: GrantPendingPaymentDto | null;
  @ApiProperty({ type: [SubscriptionGrantDto] })
  recentGrants!: SubscriptionGrantDto[];
}
