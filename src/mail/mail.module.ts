import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LogMailTransport,
  MailModule as NestMailModule,
  ResendTransport,
} from '@nestjs/mail';
import { MailService } from './mail.service.js';

@Global()
@Module({
  imports: [
    NestMailModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('RESEND_API_KEY', '');
        // Without a key (allowed only outside production) codes go to the log.
        return {
          transport: apiKey
            ? new ResendTransport({ apiKey })
            : new LogMailTransport(),
          from: config.getOrThrow<string>('MAIL_FROM'),
        };
      },
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
