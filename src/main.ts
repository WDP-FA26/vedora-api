import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { setupSwagger } from './swagger.setup.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Cloudinary notification signatures are computed over the exact request body.
    rawBody: true,
  });
  configureApp(app);
  app.enableShutdownHooks();
  setupSwagger(app);

  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
