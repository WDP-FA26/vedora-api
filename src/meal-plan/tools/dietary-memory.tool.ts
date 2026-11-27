import { tool } from 'ai';
import { z } from 'zod';
import type { DietaryService } from '../../recipes/dietary.service.js';
import {
  MAX_MEMORY_ITEM_LENGTH,
  MAX_MEMORY_ITEMS,
} from '../../recipes/dto/dietary.dto.js';

const lines = z
  .array(z.string().trim().min(1).max(MAX_MEMORY_ITEM_LENGTH))
  .max(MAX_MEMORY_ITEMS);

export function updateMemoryTool(
  dietary: DietaryService,
  userId: string,
  onAllergiesSaved: (allergies: string[]) => void,
) {
  return tool({
    description: `Add or remove lines in what you remember about the user ("Ghi nhớ" in their dietary profile), which you read at the start of every chat. Two sections:
- allergies: allergies, intolerances, and anything they must never eat for health or religion ("dị ứng đậu phộng", "ăn mè bị nổi mẩn", "ăn chay ngũ vị tân"). Save these as soon as the user mentions one. Only remove a line when the user clearly says it no longer applies, and confirm with the user first (use askUser in chat, or ask aloud in voice). After adding one, if their plan already has dishes, run verifyMealPlanAllergies.
- preferences: lasting tastes and habits ("không thích nấm", "nhà mình chỉ nấu bữa tối", "nấu cho 3 người", "tối đa 30 phút"), not one-off requests. Remove a line when they say it no longer holds.
Each line is one short fact in Vietnamese. To change a line, remove the old one (copied exactly) and add the new one. Tell the user in one short sentence what you noted; they can edit it in the "Dị ứng & Gu" tab or "Hồ sơ ăn uống".`,
    inputSchema: z.object({
      section: z.enum(['allergies', 'preferences']),
      add: lines.optional().describe('New lines to save'),
      remove: lines
        .optional()
        .describe('Saved lines to drop, copied exactly from the current list'),
    }),
    execute: async ({ section, add, remove }) => {
      const saved = await dietary.updateMemory(userId, section, {
        add,
        remove,
      });
      if (section === 'allergies') onAllergiesSaved(saved);
      return { section, lines: saved };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value:
        output.lines.length > 0
          ? `Saved. ${output.section} is now:\n${output.lines.map((line) => `- ${line}`).join('\n')}`
          : `Saved. ${output.section} is now empty.`,
    }),
  });
}
