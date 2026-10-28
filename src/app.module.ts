import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppExceptionFilter } from './common/exceptions/app-exception.filter.js';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnvironment } from './config/environment.js';
import { PaymentsModule } from './payments/payments.module.js';
import { AppController } from './app.controller.js';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module.js';
import { AuthModule } from './auth/auth.module.js';
import { StorageModule } from './storage/storage.module.js';
import { StorageWebhookModule } from './storage/storage-webhook.module.js';
import { HealthModule } from './health/health.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { CloudinaryModule } from './cloudinary/cloudinary.module.js';
import { MailModule } from './mail/mail.module.js';
import { MealPlanModule } from './meal-plan/meal-plan.module.js';
import { MediaModule } from './media/media.module.js';
import { NutritionChatModule } from './nutrition-chat/nutrition-chat.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PostsModule } from './posts/posts.module.js';
import { MongoModule } from './mongo/mongo.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { QdrantModule } from './qdrant/qdrant.module.js';
import { RecipesModule } from './recipes/recipes.module.js';
import { UsersModule } from './users/users.module.js';
import { VerificationModule } from './verification/verification.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    ScheduleModule.forRoot(),
    MongoModule.forRoot(),
    MailModule,
    CloudinaryModule,
    StorageModule,
    QdrantModule,
    RecipesModule,
    MealPlanModule,
    AuthModule,
    HealthModule,
    UsersModule,
    AdminDashboardModule,
    PaymentsModule,
    MediaModule,
    PostsModule,
    NotificationsModule,
    NutritionChatModule,
    KnowledgeModule,
    ProfilesModule,
    VerificationModule,
    StorageWebhookModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
})
export class AppModule {}
