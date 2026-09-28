import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'vedora.user' })
  username!: string;

  @ApiProperty({ example: 'Vedora User' })
  fullName!: string;

  @ApiProperty({ example: 'hello@vedora.vn' })
  email!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({
    description: 'Access token lifetime in seconds',
    example: 3600,
  })
  accessTokenExpiresIn!: number;

  @ApiProperty({
    description: 'Refresh token lifetime in seconds',
    example: 2592000,
  })
  refreshTokenExpiresIn!: number;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}
