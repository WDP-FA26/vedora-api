import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { loadTextConfig } from '../../config/config-files.js';
import { DEFAULT_CHAT_MODEL } from '../../ai/openrouter.js';
import type { PostSourcePart } from '../../posts/summaries/post-source.js';
import {
  type DraftCatalog,
  type DraftOutput,
  describeCatalog,
  draftOutput,
} from './recipe-draft.js';

const INSTRUCTIONS = loadTextConfig(runtimeConfig.RECIPE_DRAFT_PROMPT_FILE);
const TIMEOUT_MS = runtimeConfig.RECIPE_DRAFT_TIMEOUT_MS;

/** Asks the chat model for a recipe draft of a source, matched to the catalog. */
@Injectable()
export class RecipeDraftGenerator {
  readonly modelId: string;

  constructor(
    private readonly ai: AiService,
    config: ConfigService,
  ) {
    this.modelId = config.get<string>('OPENROUTER_MODEL', DEFAULT_CHAT_MODEL);
  }

  async generate(
    parts: PostSourcePart[],
    catalog: DraftCatalog,
  ): Promise<DraftOutput> {
    const sections: string[] = [];
    for (const part of parts) {
      sections.push(`## ${part.label}\n${part.text}`);
    }
    const { object } = await this.ai.generateObject({
      label: 'draft-recipe',
      instructions: INSTRUCTIONS,
      prompt: [
        `<catalog>\n${describeCatalog(catalog)}\n</catalog>`,
        `<source>\n${sections.join('\n\n')}\n</source>`,
      ].join('\n\n'),
      schema: draftOutput,
      schemaName: 'recipe_draft',
      timeout: TIMEOUT_MS,
    });
    return object;
  }
}
