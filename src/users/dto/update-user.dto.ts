import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'vedora.user' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsOptional()
  @IsString()
  @MinLength(runtimeConfig.AUTH_USERNAME_MIN_LENGTH)
  @MaxLength(runtimeConfig.AUTH_USERNAME_MAX_LENGTH)
  @Matches(/^[a-z0-9._-]+$/)
  username?: string;

  @ApiPropertyOptional({ example: 'Vedora User' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH)
  fullName?: string;
}
