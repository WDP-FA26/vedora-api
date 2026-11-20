import { Injectable } from '@nestjs/common';
import { Mailer } from '@nestjs/mail';

export type SupportFollowUpKind = 'REMINDER' | 'FINAL_REMINDER' | 'EXPIRED';

export interface SupportFollowUpEmail {
  kind: SupportFollowUpKind;
  ticketCode: string;
  ticketSubject: string;
  message: string;
  ticketUrl: string;
}

const SUPPORT_FOLLOW_UP_COPY: Record<
  SupportFollowUpKind,
  { subject: string; action: string }
> = {
  REMINDER: {
    subject: 'Vedora đang chờ phản hồi của bạn',
    action: 'Trả lời hồ sơ',
  },
  FINAL_REMINDER: {
    subject: 'Hồ sơ hỗ trợ sắp tự động đóng',
    action: 'Trả lời hồ sơ',
  },
  EXPIRED: {
    subject: 'Hồ sơ hỗ trợ đã tự động đóng',
    action: 'Xem hồ sơ',
  },
};

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Ticket subjects are user input, so they are escaped before going into HTML. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

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

  /**
   * A support-ticket follow-up (reminder, final warning or auto-close) that
   * mirrors the in-app notification, Zendesk-style. The thread stays the
   * source of truth, so the email only links back to it.
   */
  async sendSupportFollowUp(
    to: string,
    followUp: SupportFollowUpEmail,
  ): Promise<void> {
    const copy = SUPPORT_FOLLOW_UP_COPY[followUp.kind];
    const subject = `[${followUp.ticketCode}] ${copy.subject}`;
    const text = [
      `Hồ sơ ${followUp.ticketCode}: ${followUp.ticketSubject}`,
      '',
      followUp.message,
      '',
      `${copy.action}: ${followUp.ticketUrl}`,
    ].join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
  <p style="color:#57534e;margin:0 0 4px">Hồ sơ ${escapeHtml(followUp.ticketCode)}</p>
  <p style="font-weight:600;margin:0 0 16px">${escapeHtml(followUp.ticketSubject)}</p>
  <p>${escapeHtml(followUp.message)}</p>
  <p style="margin:24px 0"><a href="${escapeHtml(followUp.ticketUrl)}" style="background:#255d32;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">${copy.action}</a></p>
  <p style="color:#78716c;font-size:13px">Bạn nhận email này vì đã gửi yêu cầu hỗ trợ tới Vedora.</p>
</div>`;

    await this.mailer.send({ to, subject, text, html });
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
