import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/**
 * Transactional email through Resend. Without `RESEND_API_KEY` (allowed only
 * outside production) messages are written to the log instead, so local
 * sign-up works without an email account.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('RESEND_API_KEY', '');
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = configService.getOrThrow<string>('MAIL_FROM');
  }

  async sendVerificationCode(to: string, code: string): Promise<void> {
    const subject = `${code} là mã xác minh Vedora của bạn`;
    const text = [
      `Mã xác minh email của bạn là: ${code}`,
      '',
      'Mã có hiệu lực trong 10 phút. Nếu bạn không đăng ký Vedora, hãy bỏ qua email này.',
    ].join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
  <p>Mã xác minh email của bạn là:</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>
  <p style="color:#57534e">Mã có hiệu lực trong 10 phút. Nếu bạn không đăng ký Vedora, hãy bỏ qua email này.</p>
</div>`;

    if (!this.resend) {
      this.logger.warn(`RESEND_API_KEY is empty; code for ${to}: ${code}`);
      return;
    }

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      text,
      html,
    });
    if (error) {
      throw new Error(`Resend rejected the email: ${error.message}`);
    }
  }
}
