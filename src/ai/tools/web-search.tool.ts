import { type Tool } from 'ai';
import { providerAdapter } from '../providers/provider-registry.js';

/** The web search server tool of the provider in use. */
export function webSearchTool(): Tool {
  return providerAdapter().webSearchTool();
}
