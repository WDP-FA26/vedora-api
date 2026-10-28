import { Injectable } from '@nestjs/common';
import { Mailer } from '@nestjs/mail';

/**
 * Transactional email through `@nestjs/mail`. The transport is chosen in
 * `MailModule`: Resend, or the log when `RESEND_API_KEY` is empty (allowed only
 * outside production), so local sign-up works without an email account.
 */
@Injectable()
export class MailService {
  constructor(private readonly mailer: Mailer) {}

  async sendVerificationCode(to: string, code: string): Promise<void> {
    await this.sendCode(to, code, {
      subject: `${code} là mã xác minh Vedora của bạn`,
      intro: 'Mã xác minh email của bạn là:',
      footer:
        'Mã có hiệu lực trong 10 phút. Nếu bạn không đăng ký Vedora, hãy bỏ qua email này.',
    });
  }

  async sendPasswordResetCode(to: string, code: string): Promise<void> {
    await this.sendCode(to, code, {
      subject: `${code} là mã đặt lại mật khẩu Vedora của bạn`,
      intro: 'Mã đặt lại mật khẩu của bạn là:',
      footer:
        'Mã có hiệu lực trong 10 phút. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này; mật khẩu của bạn vẫn giữ nguyên.',
    });
  }

  private async sendCode(
    to: string,
    code: string,
    copy: { subject: string; intro: string; footer: string },
  ): Promise<void> {
    const text = [`${copy.intro} ${code}`, '', copy.footer].join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
  <p>${copy.intro}</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>
  <p style="color:#57534e">${copy.footer}</p>
</div>`;

    await this.mailer.send({ to, subject: copy.subject, text, html });
  }
}
