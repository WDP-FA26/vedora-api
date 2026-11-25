import type { DecisionPolicy } from '../../common/decision/decision.js';
import type { VoiceInterruption } from '../dto/meal-plan-voice.dto.js';

/**
 * Reads what the user said while the voice agent was still working on an
 * earlier request. Stopping on every word would throw away work the user only
 * asked about ("xong chưa?"), and finishing everything would ignore a
 * correction, so a small decision call tells the three apart.
 */
export const VOICE_INTERRUPTION_POLICY: DecisionPolicy<VoiceInterruption> = {
  type: 'choice',
  instructions:
    'A voice assistant for a vegetarian meal planner is still working on an earlier request when the user speaks again. The conversation shows that request, the assistant saying it is working on it, and then the new words, transcribed from speech (they may lack Vietnamese diacritics, repeat words or contain recognition errors). Decide what the new words mean for the work in progress. When the words could be either a check on progress or a change to the request, choose supersede, because finishing a request the user has changed saves data they did not want.',
  criteria: {
    progress:
      'The user only checks on, waits for or agrees with the work in progress and asks for nothing new, e.g. "xong chưa", "lâu thế", "ừ", "ok", "được rồi", "cứ làm đi", "cập nhật đi".',
    supersede:
      'The user corrects, changes or stops the earlier request, so finishing it as asked would be wrong, e.g. "à không, thứ bảy chứ", "thôi dừng lại", "đổi sang món khác đi", "khoan đã", "nhầm rồi".',
    queue:
      'The user asks for something separate that does not change the earlier request and can wait until it is done, e.g. a question about another dish, day or their weight.',
  },
};
