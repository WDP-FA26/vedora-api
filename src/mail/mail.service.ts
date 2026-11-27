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

export interface WorkspaceReviewEmail {
  decision: 'APPROVED' | 'REJECTED';
  workspaceName: string;
  workspaceUrl: string;
  rejectReasonLabel?: string | null;
  note?: string | null;
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

  async sendWorkspaceReviewResult(
    to: string,
    review: WorkspaceReviewEmail,
  ): Promise<void> {
    const approved = review.decision === 'APPROVED';
    const subject = approved
      ? `Trang nhà hàng "${review.workspaceName}" đã được duyệt trên Vedora`
      : `Đơn mở trang nhà hàng "${review.workspaceName}" chưa được duyệt`;
    const actionLabel = approved
      ? 'Xem trang nhà hàng'
      : 'Chỉnh sửa và gửi lại đơn';

    const textLines: string[] = [];
    if (approved) {
      textLines.push(
        `Chúc mừng! Đơn mở trang nhà hàng "${review.workspaceName}" của bạn đã được quản trị viên Vedora phê duyệt.`,
      );
      if (review.note) {
        textLines.push('', `Ghi chú từ quản trị viên: ${review.note}`);
      }
    } else {
      textLines.push(
        `Đơn mở trang nhà hàng "${review.workspaceName}" của bạn chưa được duyệt.`,
      );
      if (review.rejectReasonLabel) {
        textLines.push('', `Lý do từ chối: ${review.rejectReasonLabel}`);
      }
      if (review.note) {
        textLines.push(`Chi tiết từ quản trị viên: ${review.note}`);
      }
      textLines.push(
        '',
        'Bạn có thể cập nhật thông tin và gửi lại đơn bất cứ lúc nào.',
      );
    }
    textLines.push('', `${actionLabel}: ${review.workspaceUrl}`);

    const htmlParts: string[] = [];
    if (approved) {
      htmlParts.push(
        `<p>Chúc mừng! Đơn mở trang nhà hàng <strong>${escapeHtml(review.workspaceName)}</strong> của bạn đã được quản trị viên Vedora phê duyệt.</p>`,
      );
      if (review.note) {
        htmlParts.push(
          `<p><strong>Ghi chú từ quản trị viên:</strong> ${escapeHtml(review.note)}</p>`,
        );
      }
    } else {
      htmlParts.push(
        `<p>Đơn mở trang nhà hàng <strong>${escapeHtml(review.workspaceName)}</strong> của bạn chưa được duyệt.</p>`,
      );
      if (review.rejectReasonLabel) {
        htmlParts.push(
          `<p><strong>Lý do từ chối:</strong> ${escapeHtml(review.rejectReasonLabel)}</p>`,
        );
      }
      if (review.note) {
        htmlParts.push(
          `<p><strong>Chi tiết từ quản trị viên:</strong> ${escapeHtml(review.note)}</p>`,
        );
      }
      htmlParts.push(
        `<p>Bạn có thể cập nhật thông tin và gửi lại đơn bất cứ lúc nào.</p>`,
      );
    }

    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
  ${htmlParts.join('\n  ')}
  <p style="margin:24px 0"><a href="${escapeHtml(review.workspaceUrl)}" style="background:#255d32;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">${actionLabel}</a></p>
  <p style="color:#78716c;font-size:13px">Bạn nhận email này vì đã gửi đơn đăng ký trang nhà hàng trên Vedora.</p>
</div>`;

    await this.mailer.send({
      to,
      subject,
      text: textLines.join('\n'),
      html,
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
