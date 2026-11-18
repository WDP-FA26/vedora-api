import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ResendVerificationDto } from './email-verification.dto.js';

export class ForgotPasswordDto extends ResendVerificationDto {}

export class ResetPasswordDto extends ResendVerificationDto {
  @ApiProperty({
    example: '123456',
    description: 'Six-digit code from the password reset email',
  })
  @Matches(new RegExp('^[0-9]{' + runtimeConfig.AUTH_OTP_LENGTH + '}$'), {
    message: `code must be ${runtimeConfig.AUTH_OTP_LENGTH} digits`,
  })
  code!: string;

  @ApiProperty({ example: 'NewStrongPassword123!' })
  @IsString()
  @MinLength(runtimeConfig.AUTH_PASSWORD_MIN_LENGTH)
  @MaxLength(72)
  password!: string;
}
