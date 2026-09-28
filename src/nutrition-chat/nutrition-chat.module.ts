import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NutritionChatController } from './nutrition-chat.controller';
import { NutritionChatService } from './nutrition-chat.service';

@Module({
  imports: [
    KnowledgeModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [NutritionChatController],
  providers: [NutritionChatService],
})
export class NutritionChatModule {}
