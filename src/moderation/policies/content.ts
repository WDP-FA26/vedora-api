import { runtimeConfig } from '../../config/runtime-config.js';
import {
  loadJsonConfig,
  validContentPolicy,
} from '../../config/config-files.js';

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
/**
 * Content that tries to steer the AI or the moderators into judging it
 * favourably. Built in: always part of the policy, whatever admins save.
 */
export const MANIPULATION_KEY = 'manipulation';

export const DEFAULT_CONTENT_POLICY: ContentPolicySettings = loadJsonConfig(
  runtimeConfig.MODERATION_DEFAULT_POLICY_FILE,
  validContentPolicy,
);

function defaultManipulationChoice(): ContentChoice {
  const choice = DEFAULT_CONTENT_POLICY.choices.find(
    ({ key }) => key === MANIPULATION_KEY,
  );
  if (!choice) {
    throw new Error(
      `${runtimeConfig.MODERATION_DEFAULT_POLICY_FILE} must define the "${MANIPULATION_KEY}" category`,
    );
  }
  return choice;
}

const DEFAULT_MANIPULATION_CHOICE = defaultManipulationChoice();

/** The choices with the built-in categories added when they are missing. */
export function withReservedChoices(choices: ContentChoice[]): ContentChoice[] {
  if (choices.some(({ key }) => key === MANIPULATION_KEY)) return choices;
  return [...choices, { ...DEFAULT_MANIPULATION_CHOICE }];
}

