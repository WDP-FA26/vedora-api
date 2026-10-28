import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../mongo/models.js';
import { IsEnum } from 'class-validator';
import { AccountOperationDto } from './account-operation.dto.js';

export class UpdateUserRoleDto extends AccountOperationDto {
  @ApiProperty({ enum: UserRole, example: UserRole.USER })
  @IsEnum(UserRole)
  role!: UserRole;
}
