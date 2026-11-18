import 'dotenv/config';
import { parseRuntimeSettings } from './runtime-settings.js';

/**
 * Immutable startup snapshot. Loaded before DTO decorators and cron registration,
 * so validators and services use the same values, including values from .env.
 * Changes take effect on restart; module imports do not depend on Nest DI order.
 */
export const runtimeConfig = parseRuntimeSettings(process.env);
