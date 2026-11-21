import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, ValidateIf } from 'class-validator';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';
import { RefreshTokenDto } from './refresh-token.dto.js';

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

  @ApiProperty({
    type: () => SessionActorDto,
    nullable: true,
    description:
      'The person acting as `user` in a page session; null otherwise',
  })
  actor!: SessionActorDto | null;
}

export class SessionActorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
}

export class CurrentUserDto extends UserResponseDto {
  @ApiProperty({
    type: SessionActorDto,
    nullable: true,
    description: 'The person acting as this page; null in a personal session',
  })
  actor!: SessionActorDto | null;
}

export class SwitchAccountDto extends RefreshTokenDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The page to act as, or null to go back to your own account',
  })
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsUUID('4')
  pageId!: string | null;
}
