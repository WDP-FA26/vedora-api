import { tool } from 'ai';
import { z } from 'zod';
import type { DietaryService } from '../../recipes/dietary.service.js';
import {
  MAX_ALLERGY_NOTE_LENGTH,
  MAX_PREFERENCE_NOTE_LENGTH,
} from '../../recipes/dto/dietary.dto.js';

/**
 * Rewrites the "Sở thích" note in the user's dietary profile, the planner's
 * memory across chats. The user sees and edits the same text in their profile.
 */
export function updatePreferencesTool(dietary: DietaryService, userId: string) {
  return tool({
    description: `Rewrite the user's taste and habit note ("Sở thích" in their dietary profile), which you read at the start of every chat. Use it when the user states something lasting ("mình không thích nấm", "nhà mình chỉ nấu bữa tối", "nấu cho 3 người", "tối đa 30 phút") or says an old preference no longer holds; not for a one-off request. Send the whole new note: keep what still holds from the current note, add or remove the change, short lines in Vietnamese. Something they must not eat (allergy, intolerance, religion) goes in updateAllergyNote instead. Tell the user in one short sentence what you noted; they can edit it in "Hồ sơ ăn uống".`,
    inputSchema: z.object({
      note: z
        .string()
        .max(MAX_PREFERENCE_NOTE_LENGTH)
        .describe('The full new note; an empty string clears it'),
    }),
    execute: async ({ note }) => ({
      preferenceNote: await dietary.savePreferenceNote(userId, note),
    }),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: output.preferenceNote
        ? `Saved. The note is now:\n${output.preferenceNote}`
        : 'Saved. The note is now empty.',
    }),
  });
}

/**
 * Rewrites the allergy note in the user's dietary profile. The app checks
 * planned dishes against it, so `onSaved` lets the rest of the turn use the
 * new note at once.
 */
export function updateAllergyNoteTool(
  dietary: DietaryService,
  userId: string,
  onSaved: (note: string | null) => void,
) {
  return tool({
    description: `Rewrite the user's allergy note ("Dị ứng" in their dietary profile), which the allergy check uses on every planned dish. Use it when the user tells you about an allergy, intolerance, or something they must not eat for health or religion ("mình dị ứng tôm... à không, dị ứng đậu phộng", "ăn mè bị nổi mẩn", "mình ăn chay ngũ vị tân"). Send the whole new note: keep everything from the current note and add the new item. Only drop an item when the user clearly says it no longer applies, and confirm with askUser before you drop one. After saving, if their plan already has dishes, run verifyMealPlanAllergies. Tell the user in one short sentence what you added; they can edit it in "Hồ sơ ăn uống".`,
    inputSchema: z.object({
      note: z
        .string()
        .max(MAX_ALLERGY_NOTE_LENGTH)
        .describe('The full new allergy note in Vietnamese'),
    }),
    execute: async ({ note }) => {
      const allergyNote = await dietary.saveAllergyNote(userId, note);
      onSaved(allergyNote);
      return { allergyNote };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: output.allergyNote
        ? `Saved. The allergy note is now:\n${output.allergyNote}`
        : 'Saved. The allergy note is now empty.',
    }),
  });
}
