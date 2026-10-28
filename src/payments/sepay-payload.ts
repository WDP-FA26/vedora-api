import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { validatePayload } from '../common/validation.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

/** SePay's "Banking" webhook body, as sent on a completed transfer. */
class BankWebhookPayload {
  // SePay sends a number for recent transactions and a string once it grows.
  // A number beyond the safe-integer range is imprecise: keep it a number so
  // the format rule rejects it instead of rounding it silently.
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value > 0
        ? String(value)
        : value
      : value,
  )
  @Matches(/^[1-9]\d{0,29}$/)
  id!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^.{1,100}$/)
  gateway!: string;

  @Matches(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  transactionDate!: string;

  @IsString()
  @Matches(/^.{1,100}$/)
  accountNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  subAccount?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  code?: string | null;

  @IsIn(['in', 'out'])
  transferType!: 'in' | 'out';

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  transferAmount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  referenceCode?: string | null;
}

export function parseBankWebhook(body: unknown) {
  const parsed = validatePayload(BankWebhookPayload, body);
  const data = parsed.value;
  if (!data)
    throw new InvalidInputException(
      'BAD_REQUEST',
      'Invalid SePay Banking payload',
    );
  const localIso = data.transactionDate.replace(' ', 'T');
  const paidAt = new Date(`${localIso}+07:00`);
  // Strict round-trip rejects invalid dates and leap/clock overflows.
  if (
    !Number(data.transactionDate.slice(0, 4)) ||
    !Number.isFinite(paidAt.getTime()) ||
    new Date(paidAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 19) !==
      localIso
  )
    throw new InvalidInputException(
      'BAD_REQUEST',
      'Invalid SePay transactionDate',
    );
  return { ...data, paidAt, providerTransactionId: `BANK-${data.id}` };
}
