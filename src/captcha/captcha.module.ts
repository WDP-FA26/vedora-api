import { Module } from '@nestjs/common';
import { TurnstileService } from './turnstile.service.js';

@Module({
  providers: [TurnstileService],
  exports: [TurnstileService],
})
export class CaptchaModule {}
