import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, AccountType, UserRole } from '../../mongo/models.js';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'vedora.user' })
  username!: string;

  @ApiProperty({ example: 'Vedora User' })
  fullName!: string;

  @ApiProperty({ example: 'hello@vedora.vn' })
  email!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uri' })
  avatarUrl!: string | null;

  @ApiProperty({ enum: UserRole, example: UserRole.USER })
  role!: UserRole;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty({
    enum: AccountType,
    description: 'PAGE for a restaurant page account',
  })
  accountType!: AccountType;

  @ApiProperty({ minimum: 0 })
  accountVersion!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
