import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const payloadSchema = z.object({
  id: z.union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^[1-9]\d{0,29}$/),
  ]),
  gateway: z.string().min(1).max(100),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  accountNumber: z.string().min(1).max(100),
  subAccount: z.string().max(100).nullish(),
  code: z.string().max(100).nullish(),
  content: z.string().max(4096).nullish(),
  transferType: z.enum(['in', 'out']),
  transferAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  referenceCode: z.string().max(255).nullish(),
});

export function parseBankWebhook(body: unknown) {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success)
    throw new BadRequestException('Invalid SePay Banking payload');
  const data = parsed.data;
  const localIso = data.transactionDate.replace(' ', 'T');
  const paidAt = new Date(`${localIso}+07:00`);
  // Strict round-trip rejects invalid dates and leap/clock overflows.
  if (
    !Number(data.transactionDate.slice(0, 4)) ||
    !Number.isFinite(paidAt.getTime()) ||
    new Date(paidAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 19) !==
      localIso
  )
    throw new BadRequestException('Invalid SePay transactionDate');
  return { ...data, paidAt, providerTransactionId: `BANK-${data.id}` };
}
