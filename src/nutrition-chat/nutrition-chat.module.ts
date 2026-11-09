import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CaptchaModule } from '../captcha/captcha.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { ClientIpService } from './guest/client-ip.service.js';
import { GuestChatGuard } from './guest/guest-chat.guard.js';
import { GuestQuotaService } from './guest/guest-quota.service.js';
import { GuestSessionService } from './guest/guest-session.service.js';
import { NutritionChatController } from './nutrition-chat.controller.js';
import { NutritionChatService } from './nutrition-chat.service.js';

@Module({
  imports: [
    CaptchaModule,
    KnowledgeModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [NutritionChatController],
  providers: [
    NutritionChatService,
    ClientIpService,
    GuestSessionService,
    GuestQuotaService,
    GuestChatGuard,
  ],
})
export class NutritionChatModule {}
