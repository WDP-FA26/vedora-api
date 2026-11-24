import { runtimeConfig } from '@src/config/runtime-config.js';
import {
  loadJsonConfig,
  validDecisionPolicy,
} from '@src/config/config-files.js';
import type { DecisionPolicy } from '@src/common/decision/decision.js';
import type { ModerationVerdict } from '../guardrail.js';

export const NUTRITION_POLICY: DecisionPolicy<ModerationVerdict> =
  loadJsonConfig(runtimeConfig.NUTRITION_GUARDRAIL_POLICY_FILE, (value) =>
    validDecisionPolicy(value, [
      'self_harm',
      'injection',
      'harmful',
      'unsupported_language',
      'off_topic',
      'allow',
    ]),
  );
