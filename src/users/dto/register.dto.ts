import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'vedora.user' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsString()
  @MinLength(runtimeConfig.AUTH_USERNAME_MIN_LENGTH)
  @MaxLength(runtimeConfig.AUTH_USERNAME_MAX_LENGTH)
  @Matches(/^[a-z0-9._-]+$/, {
    message:
      'username can only contain lowercase letters, numbers, dots, underscores and hyphens',
  })
  username!: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  @IsString()
  @MinLength(runtimeConfig.AUTH_PASSWORD_MIN_LENGTH)
  @MaxLength(72)
  password!: string;

  @ApiProperty({ example: 'Vedora User' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH)
  fullName!: string;

  @ApiProperty({ example: 'hello@vedora.vn' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
