import { isStepCount, ToolLoopAgent } from 'ai';
import { chatModel } from '../ai/openrouter.js';
import type { ReasoningEffort } from '../ai/reasoning.js';
import { searchKnowledgeTool } from '../ai/tools/search-knowledge.tool.js';
import type { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { INSTRUCTIONS } from './nutrition-chat.prompt.js';

// guests get two searches and an answer, and a bounded reply
const MAX_STEPS = 3;
const MAX_OUTPUT_TOKENS = 1000;

interface NutritionAgentOptions {
  apiKey: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  knowledge: KnowledgeSearchService;
}

type NutritionTools = {
  searchKnowledge: ReturnType<typeof searchKnowledgeTool>;
};

export class NutritionAgent extends ToolLoopAgent<never, NutritionTools> {
  constructor({
    apiKey,
    modelId,
    reasoningEffort,
    knowledge,
  }: NutritionAgentOptions) {
    super({
      model: chatModel({ apiKey, modelId, reasoningEffort }),
      instructions: INSTRUCTIONS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: { searchKnowledge: searchKnowledgeTool(knowledge) },
      stopWhen: isStepCount(MAX_STEPS),
      prepareStep: ({ stepNumber }) =>
        stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : {},
    });
  }
}
