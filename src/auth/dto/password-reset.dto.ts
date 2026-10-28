import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ResendVerificationDto } from './email-verification.dto.js';

export class ForgotPasswordDto extends ResendVerificationDto {}

export class ResetPasswordDto extends ResendVerificationDto {
  @ApiProperty({
    example: '123456',
    description: 'Six-digit code from the password reset email',
  })
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  @ApiProperty({ example: 'NewStrongPassword123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
