import { tool } from 'ai';
import { z } from 'zod';

export const MAX_ASK_USER_OPTIONS = 6;

export function askUserTool() {
  return tool({
    description:
      'Ask the user to choose before you change their plan, when the request is open (which dish to swap to, which days, how much to change) or a change would replace many dishes they already have. The app shows each option as a button; the answer arrives as the next user message. Call it as the last step of your turn, after a short sentence of context, and do not repeat the options in your text.',
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(200)
        .describe('One short question in Vietnamese'),
      options: z
        .array(z.string().min(1).max(80))
        .min(2)
        .max(MAX_ASK_USER_OPTIONS)
        .describe(
          'Short answers in Vietnamese, e.g. dish titles from searchRecipes ("Đậu hũ sốt cà (~320 kcal)") or actions ("Cân đối cả tuần", "Chỉ thứ Hai")',
        ),
      multiple: z
        .boolean()
        .optional()
        .describe('true when the user may pick more than one option'),
    }),
    outputSchema: z.object({
      answer: z.string(),
    }),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: output.answer,
    }),
  });
}
