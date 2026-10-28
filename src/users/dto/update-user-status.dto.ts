import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '../../mongo/models.js';
import { IsIn } from 'class-validator';
import { AccountOperationDto } from './account-operation.dto.js';

export class UpdateUserStatusDto extends AccountOperationDto {
  @ApiProperty({ enum: [AccountStatus.ACTIVE, AccountStatus.SUSPENDED] })
  @IsIn([AccountStatus.ACTIVE, AccountStatus.SUSPENDED])
  status!: typeof AccountStatus.ACTIVE | typeof AccountStatus.SUSPENDED;
}
