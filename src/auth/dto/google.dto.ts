import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class GoogleAuthorizationDto {
  @ApiProperty({ description: "Google's consent screen URL" })
  url!: string;

  @ApiProperty({ description: 'Nonce to store and compare on return' })
  state!: string;

  @ApiProperty({ description: 'PKCE verifier to send back with the code' })
  codeVerifier!: string;
}

export class GoogleExchangeDto {
  @ApiProperty({ description: 'Authorization code Google returned' })
  @IsString()
  @Length(1, 2048)
  code!: string;

  @ApiProperty({ description: 'PKCE verifier from POST /auth/google/authorize' })
  @Matches(/^[A-Za-z0-9._~-]{43,128}$/)
  codeVerifier!: string;
}
