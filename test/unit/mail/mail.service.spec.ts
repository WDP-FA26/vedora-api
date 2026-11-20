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

  it('sends support follow-ups with the ticket link and escaped subject', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new MailService({ send } as unknown as Mailer);

    await service.sendSupportFollowUp('user@example.com', {
      kind: 'FINAL_REMINDER',
      ticketCode: 'TKT-ABC123',
      ticketSubject: '<b>Gói Plus</b> & thanh toán',
      message: 'Hồ sơ sẽ tự động đóng lúc 10:00 22/11/2026.',
      ticketUrl: 'http://localhost:3000/home/support/ticket-1',
    });

    const [mail] = send.mock.calls[0] as [
      { to: string; subject: string; text: string; html: string },
    ];
    expect(mail.to).toBe('user@example.com');
    expect(mail.subject).toBe('[TKT-ABC123] Hồ sơ hỗ trợ sắp tự động đóng');
    expect(mail.text).toContain('http://localhost:3000/home/support/ticket-1');
    expect(mail.html).toContain('&lt;b&gt;Gói Plus&lt;/b&gt; &amp; thanh toán');
    expect(mail.html).not.toContain('<b>Gói Plus</b>');
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
