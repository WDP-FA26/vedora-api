import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PublicUser } from '../users/users.service';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import {
  ResendVerificationDto,
  VerificationRequiredDto,
  VerifyEmailDto,
} from './dto/email-verification.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { GoogleAuthorizationDto, GoogleExchangeDto } from './dto/google.dto';
import { GoogleOAuthService } from './google-oauth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuthService: GoogleOAuthService,
  ) {}

  @Post('register')
  @ApiOperation({
    summary: 'Register a user and email a verification code',
    description: 'No tokens yet: finish with POST /auth/verify-email.',
  })
  @ApiCreatedResponse({ type: VerificationRequiredDto })
  @ApiConflictResponse({ description: 'Username or email already exists' })
  register(@Body() dto: RegisterDto): Promise<VerificationRequiredDto> {
    return this.authService.register(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify the email code and issue a token pair' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid or expired code' })
  @ApiTooManyRequestsResponse({
    description:
      'Too many wrong codes for this email today (`code: VERIFY_LIMIT_REACHED`)',
  })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<AuthResponseDto> {
    return this.authService.verifyEmail(dto);
  }

  @Post('verify-email/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Email a new verification code (every 2 minutes, at most 3 resends an hour)',
    description: 'Returns 204 whether or not the email is registered.',
  })
  @ApiNoContentResponse()
  @ApiTooManyRequestsResponse({
    description: 'Resend limit reached (`code: RESEND_LIMIT_REACHED`)',
  })
  @ApiServiceUnavailableResponse({ description: 'The email could not be sent' })
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<void> {
    await this.authService.resendVerification(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with username and password' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid username or password' })
  @ApiForbiddenResponse({
    description:
      'Right password but unverified email (`code: EMAIL_NOT_VERIFIED`); a code was sent to `email`',
  })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Post('password/forgot')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Email a password reset code (every 2 minutes, at most 3 resends an hour)',
    description:
      'Returns 204 whether or not the email is registered. Finish with POST /auth/password/reset.',
  })
  @ApiNoContentResponse()
  @ApiTooManyRequestsResponse({
    description: 'Code limit reached (`code: RESEND_LIMIT_REACHED`)',
  })
  @ApiServiceUnavailableResponse({ description: 'The email could not be sent' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.authService.forgotPassword(dto);
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with the emailed code',
    description:
      'Also verifies the email and revokes every refresh token; log in again afterwards.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Invalid or expired code' })
  @ApiTooManyRequestsResponse({
    description:
      'Too many wrong codes for this email today (`code: VERIFY_LIMIT_REACHED`)',
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.authService.resetPassword(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a refresh token and issue a new token pair',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired or reused refresh token',
  })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the refresh-token family' })
  @ApiNoContentResponse()
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('google/authorize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start Google sign-in: consent URL plus state and PKCE verifier',
  })
  @ApiOkResponse({ type: GoogleAuthorizationDto })
  @ApiServiceUnavailableResponse({ description: 'Google OAuth is not set up' })
  googleAuthorize(): Promise<GoogleAuthorizationDto> {
    return this.googleOAuthService.authorize();
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a Google authorization code (PKCE) for a token pair',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Code or verifier was rejected' })
  @ApiServiceUnavailableResponse({ description: 'Google OAuth is not set up' })
  async google(@Body() dto: GoogleExchangeDto): Promise<AuthResponseDto> {
    const profile = await this.googleOAuthService.exchangeCode(
      dto.code,
      dto.codeVerifier,
    );
    return this.authService.googleLogin(profile);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current authenticated user' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  me(@Req() request: AuthenticatedRequest): Promise<PublicUser> {
    return this.authService.getCurrentUser(request.user.sub);
  }
}
