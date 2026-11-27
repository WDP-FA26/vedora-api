import 'dotenv/config';
import { parseRuntimeSettings } from './runtime-settings.js';

export const runtimeConfig = parseRuntimeSettings(process.env);
