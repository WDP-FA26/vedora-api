import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnvironment } from './config/environment';
import { PaymentsModule } from './payments/payments.module';
import { AppController } from './app.controller';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';
import { StorageWebhookModule } from './storage/storage-webhook.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { MailModule } from './mail/mail.module';
import { MealPlanModule } from './meal-plan/meal-plan.module';
import { MediaModule } from './media/media.module';
import { NutritionChatModule } from './nutrition-chat/nutrition-chat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PostsModule } from './posts/posts.module';
import { MongoModule } from './mongo/mongo.module';
import { ProfilesModule } from './profiles/profiles.module';
import { QdrantModule } from './qdrant/qdrant.module';
import { RecipesModule } from './recipes/recipes.module';
import { UsersModule } from './users/users.module';
import { VerificationModule } from './verification/verification.module';

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
})
export class AppModule {}
