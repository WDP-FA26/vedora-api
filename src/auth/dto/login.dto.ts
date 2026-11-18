import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'vedora.user' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsString()
  @MinLength(runtimeConfig.AUTH_USERNAME_MIN_LENGTH)
  @MaxLength(runtimeConfig.AUTH_USERNAME_MAX_LENGTH)
  username!: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  @IsString()
  @MinLength(runtimeConfig.AUTH_PASSWORD_MIN_LENGTH)
  @MaxLength(72)
  password!: string;

  @ApiProperty({
    description: 'Single-use token from the Cloudflare Turnstile widget',
    maxLength: 2048,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  turnstileToken!: string;
}
