import { runtimeConfig } from '../config/runtime-config.js';
import { loadTextConfig } from '../config/config-files.js';
export const INSTRUCTIONS = loadTextConfig(
  runtimeConfig.NUTRITION_SYSTEM_PROMPT_FILE,
);
