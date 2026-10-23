import { timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BankSnapshot {
  bankCode: string;
  bankGateway: string;
  accountNumber: string;
  accountHolder: string;
  storeName: string;
  transferContent: string;
}

@Injectable()
export class SePayProvider {
  constructor(private readonly config: ConfigService) {}

  assertEnabled(): void {
    if (!this.config.get<boolean>('SEPAY_PAYMENT_ENABLED', false))
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_DISABLED',
        message: 'SePay payments are not enabled',
      });
  }

  verifyWebhook(authorization?: string): void {
    this.assertEnabled();
    const expected = this.config.get<string>('SEPAY_BANK_WEBHOOK_API_KEY', '');
    const match = /^Apikey ([^\s]+)$/i.exec(authorization ?? '');
    const actual = Buffer.from(match?.[1] ?? '');
    const secret = Buffer.from(expected);
    if (
      secret.length < 16 ||
      actual.length !== secret.length ||
      !timingSafeEqual(actual, secret)
    )
      throw new UnauthorizedException('Invalid SePay webhook credentials');
  }

  snapshot(paymentCode: string): BankSnapshot {
    this.assertEnabled();
    const read = (key: string) => this.config.getOrThrow<string>(key);
    return {
      bankCode: read('SEPAY_QR_BANK_CODE'),
      bankGateway: read('SEPAY_BANK_GATEWAY'),
      accountNumber: read('SEPAY_QR_ACCOUNT_NUMBER'),
      accountHolder: read('SEPAY_QR_ACCOUNT_HOLDER'),
      storeName: this.config.get<string>('SEPAY_QR_STORE_NAME', 'Vedora'),
      transferContent: [
        this.config.get<string>('SEPAY_QR_TRANSFER_PREFIX', ''),
        paymentCode,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  qr(bank: BankSnapshot, amount: string) {
    const url = new URL('https://vietqr.app/img');
    url.search = new URLSearchParams({
      acc: bank.accountNumber,
      bank: bank.bankCode,
      amount,
      des: bank.transferContent,
      template: 'compact',
      showinfo: 'true',
      fullacc: 'true',
      holder: bank.accountHolder,
      store: bank.storeName,
    }).toString();
    const imageUrl = url.toString();
    url.searchParams.set('download', 'true');
    return {
      bankCode: bank.bankCode,
      bankGateway: bank.bankGateway,
      accountNumber: bank.accountNumber,
      accountHolder: bank.accountHolder,
      storeName: bank.storeName,
      transferContent: bank.transferContent,
      amount,
      currency: 'VND' as const,
      imageUrl,
      downloadUrl: url.toString(),
    };
  }
}
