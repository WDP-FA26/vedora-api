import { type Tool } from 'ai';
import { providerAdapter } from '../providers/provider-registry.js';

export function webSearchTool(): Tool {
  return providerAdapter().webSearchTool();
}
