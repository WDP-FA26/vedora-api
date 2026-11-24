import type { DecisionPolicy } from '../../common/decision/decision.js';

export type WebSearchConsent = 'approve' | 'decline' | 'unclear';

/**
 * Reads the user's spoken answer to "may I search the web?". In the text chat
 * that answer is a button; in a call it is a sentence, so a small decision call
 * turns it into the same `approved` flag.
 */
export const WEB_SEARCH_CONSENT_POLICY: DecisionPolicy<WebSearchConsent> = {
  type: 'choice',
  instructions:
    'A voice assistant asked the user for permission to search the web, and the conversation ends with what the user said next, transcribed from speech (it may lack Vietnamese diacritics or contain recognition errors). Decide whether the user gave that permission. Answer unclear when the reply is about something else, asks a question back, or could go either way.',
  criteria: {
    approve:
      'The user agrees to the web search, e.g. "ừ", "được", "tìm đi", "ok bạn tìm giúp mình".',
    decline:
      'The user refuses or wants to stop, e.g. "không", "thôi", "khỏi cần", "đừng tìm".',
    unclear:
      'Neither: a new request, a question, or an answer that does not settle it.',
  },
};
