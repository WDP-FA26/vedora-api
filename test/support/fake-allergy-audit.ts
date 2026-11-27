import { getModelToken } from '@nestjs/ai';
import { FakeModel, type FakeModelCall } from '@nestjs/ai/testing';
import { AllergyAuditService } from '@src/recipes/allergy-audit.service.js';

const ALLERGEN_WORDS: Record<string, string[]> = {
  'đậu nành': ['đậu nành', 'đậu hũ', 'tương'],
  'đậu phộng': ['đậu phộng', 'lạc'],
  'rau bina': ['rau bina', 'cải bó xôi'],
};

function answerAllergyAudit(call: FakeModelCall) {
  const prompt = (call.lastUserMessage ?? '').toLowerCase();
  const profile = /<allergy_profile>([\s\S]*?)<\/allergy_profile>/.exec(
    prompt,
  )?.[1];
  const words: string[] = [];
  for (const [allergen, sources] of Object.entries(ALLERGEN_WORDS)) {
    if (profile?.includes(allergen)) words.push(...sources);
  }
  const flagged: { recipeId: string; reason: string }[] = [];
  for (const line of prompt.split('\n')) {
    const recipeId = /^- id=([^ |]+)/.exec(line)?.[1];
    if (!recipeId) continue;
    const word = words.find((candidate) => line.includes(candidate));
    if (word) flagged.push({ recipeId, reason: `Có ${word}.` });
  }
  return { object: { flagged, summary: 'Đã kiểm tra.' } };
}

export function fakeAllergyAuditModel(): FakeModel {
  return new FakeModel(answerAllergyAudit);
}

export const fakeAllergyAuditProviders = [
  AllergyAuditService,
  { provide: getModelToken(), useFactory: fakeAllergyAuditModel },
];
