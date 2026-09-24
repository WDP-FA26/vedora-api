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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PublicUser } from '../users/users.service';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
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
  @ApiOperation({ summary: 'Register a user and issue an access token' })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiConflictResponse({ description: 'Username or email already exists' })
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with username and password' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid username or password' })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
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
