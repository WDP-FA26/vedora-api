import { runtimeConfig } from '../config/runtime-config.js';
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
    ThrottlerModule.forRoot([
      {
        ttl: runtimeConfig.AI_RATE_LIMIT_WINDOW_MS,
        limit: runtimeConfig.AI_CHAT_RATE_LIMIT,
      },
    ]),
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
