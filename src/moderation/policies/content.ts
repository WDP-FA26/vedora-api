import { runtimeConfig } from '../../config/runtime-config.js';
import {
  loadJsonConfig,
  validContentPolicy,
} from '../../config/config-files.js';
import type { DecisionPolicy } from '../../common/decision/decision.js';

export interface ContentChoice {
  key: string;
  label: string;
  reasonText: string;
  description: string;
}

export interface ContentPolicySettings {
  instructions: string;
  allowDescription: string;
  choices: ContentChoice[];
}

export const ALLOW_KEY = 'allow';

export const DEFAULT_CONTENT_POLICY: ContentPolicySettings = loadJsonConfig(
  runtimeConfig.MODERATION_DEFAULT_POLICY_FILE,
  validContentPolicy,
);

export function buildContentPolicy(
  settings: ContentPolicySettings,
): DecisionPolicy<string> {
  const criteria: Record<string, string> = {};
  for (const choice of settings.choices) {
    criteria[choice.key] = choice.description;
  }
  criteria[ALLOW_KEY] = settings.allowDescription;
  return {
    type: 'choice',
    instructions: settings.instructions,
    criteria,
  };
}
