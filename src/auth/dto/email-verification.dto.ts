import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';

export class ResendVerificationDto {
  @ApiProperty({ example: 'hello@vedora.vn' })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class VerifyEmailDto extends ResendVerificationDto {
  @ApiProperty({
    example: '123456',
    description: 'Code from the email (length configured by AUTH_OTP_LENGTH)',
  })
  @Matches(new RegExp('^[0-9]{' + runtimeConfig.AUTH_OTP_LENGTH + '}$'), {
    message: `code must be ${runtimeConfig.AUTH_OTP_LENGTH} digits`,
  })
  code!: string;
}

export class VerificationRequiredDto {
  @ApiProperty({
    example: 'hello@vedora.vn',
    description: 'Address the verification code was sent to',
  })
  email!: string;
}
