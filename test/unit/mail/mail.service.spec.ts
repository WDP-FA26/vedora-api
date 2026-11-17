import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Mailer } from '@nestjs/mail';
import { MailModule } from '../../../src/mail/mail.module.js';
import { MailService } from '../../../src/mail/mail.service.js';

describe('MailService & MailModule', () => {
  it('sends formatted verification and password reset emails', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new MailService({ send } as unknown as Mailer);

    await service.sendVerificationCode('user@example.com', '123456');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: '123456 là mã xác minh Vedora của bạn',
      }),
    );

    await service.sendPasswordResetCode('user@example.com', '654321');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: '654321 là mã đặt lại mật khẩu Vedora của bạn',
      }),
    );
  });

  it('configures MailModule with LogMailTransport when RESEND_API_KEY is blank', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              RESEND_API_KEY: '',
              MAIL_FROM: 'Vedora <onboarding@resend.dev>',
            }),
          ],
        }),
        MailModule,
      ],
    }).compile();

    expect(moduleRef.get(MailService)).toBeInstanceOf(MailService);
    await moduleRef.close();
  });

  it('configures MailModule with ResendTransport when RESEND_API_KEY is set', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              RESEND_API_KEY: 're_test_key',
              MAIL_FROM: 'Vedora <no-reply@vedora.vn>',
            }),
          ],
        }),
        MailModule,
      ],
    }).compile();

    expect(moduleRef.get(MailService)).toBeInstanceOf(MailService);
    await moduleRef.close();
  });
});
