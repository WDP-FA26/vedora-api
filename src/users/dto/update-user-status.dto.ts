import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '../../mongo/models';
import { IsIn } from 'class-validator';
import { AccountOperationDto } from './account-operation.dto';

export class UpdateUserStatusDto extends AccountOperationDto {
  @ApiProperty({ enum: [AccountStatus.ACTIVE, AccountStatus.SUSPENDED] })
  @IsIn([AccountStatus.ACTIVE, AccountStatus.SUSPENDED])
  status!: typeof AccountStatus.ACTIVE | typeof AccountStatus.SUSPENDED;
}
