import { runtimeConfig } from '../config/runtime-config.js';
import { isStepCount, type LanguageModel, ToolLoopAgent } from 'ai';
import { PromptCache } from '../ai/prompt-cache.js';
import { searchKnowledgeTool } from '../knowledge/tools/search-knowledge.tool.js';
import type { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { INSTRUCTIONS } from './nutrition-chat.prompt.js';

const MAX_STEPS = runtimeConfig.NUTRITION_CHAT_MAX_STEPS;
const MAX_OUTPUT_TOKENS = runtimeConfig.NUTRITION_CHAT_MAX_OUTPUT_TOKENS;

interface NutritionAgentOptions {
  model: LanguageModel;
  knowledge: KnowledgeSearchService;
}

type NutritionTools = {
  searchKnowledge: ReturnType<typeof searchKnowledgeTool>;
};

export class NutritionAgent extends ToolLoopAgent<never, NutritionTools> {
  constructor({ model, knowledge }: NutritionAgentOptions) {
    super({
      model,
      ...PromptCache.agent({
        session: 'vedora-nutrition-chat',
        instructions: INSTRUCTIONS,
        systemTtl: '5m',
      }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: { searchKnowledge: searchKnowledgeTool(knowledge) },
      stopWhen: isStepCount(MAX_STEPS),
      prepareStep: PromptCache.finalStepGuard(MAX_STEPS),
    });
  }
}
