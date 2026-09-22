import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Opaque refresh token returned by the auth API' })
  @IsString()
  @MinLength(32)
  refreshToken!: string;
}
