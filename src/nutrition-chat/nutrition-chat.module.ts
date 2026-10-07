import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ClientIpService } from './guest/client-ip.service';
import { GuestChatGuard } from './guest/guest-chat.guard';
import { GuestQuotaService } from './guest/guest-quota.service';
import { GuestSessionService } from './guest/guest-session.service';
import { TurnstileService } from './guest/turnstile.service';
import { NutritionChatController } from './nutrition-chat.controller';
import { NutritionChatService } from './nutrition-chat.service';

@Module({
  imports: [
    KnowledgeModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [NutritionChatController],
  providers: [
    NutritionChatService,
    TurnstileService,
    ClientIpService,
    GuestSessionService,
    GuestQuotaService,
    GuestChatGuard,
  ],
})
export class NutritionChatModule {}
