import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleConfiguredGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(): boolean {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID', '');
    const clientSecret = this.configService.get<string>(
      'GOOGLE_CLIENT_SECRET',
      '',
    );
    const callbackUrl = this.configService.get<string>(
      'GOOGLE_CALLBACK_URL',
      '',
    );
    if (!clientId || !clientSecret || !callbackUrl) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }
    return true;
  }
}
