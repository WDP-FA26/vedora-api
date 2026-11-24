import { runtimeConfig } from '@src/config/runtime-config.js';
import {
  loadJsonConfig,
  validDecisionPolicy,
} from '@src/config/config-files.js';
import type { DecisionPolicy } from '@src/common/decision/decision.js';
import type { ModerationVerdict } from '../guardrail.js';

export type BlogRefusal = Exclude<ModerationVerdict, 'allow' | 'off_topic'>;
export type BlogVerdict = 'allow' | BlogRefusal;

export const BLOG_ASSISTANT_POLICY: DecisionPolicy<BlogVerdict> =
  loadJsonConfig(runtimeConfig.BLOG_GUARDRAIL_POLICY_FILE, (value) =>
    validDecisionPolicy(value, [
      'self_harm',
      'injection',
      'harmful',
      'unsupported_language',
      'allow',
    ]),
  );
