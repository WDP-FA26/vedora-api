import { isStepCount, type LanguageModel, ToolLoopAgent } from 'ai';
import { searchKnowledgeTool } from '../ai/tools/search-knowledge.tool.js';
import type { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { INSTRUCTIONS } from './nutrition-chat.prompt.js';

const MAX_STEPS = 3;
const MAX_OUTPUT_TOKENS = 1000;

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
      instructions: INSTRUCTIONS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: { searchKnowledge: searchKnowledgeTool(knowledge) },
      stopWhen: isStepCount(MAX_STEPS),
      prepareStep: ({ stepNumber }) =>
        stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : {},
    });
  }
}
