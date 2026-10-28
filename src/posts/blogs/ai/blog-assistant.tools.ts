import { tool } from 'ai';
import { z } from 'zod';
import type { KnowledgeSearchService } from '../../../knowledge/retrieval/knowledge-search.service';
import { searchKnowledgeTool } from '../../../ai/tools/search-knowledge.tool';
import {
  type BlogImageGeneratorService,
  IMAGE_ASPECT_RATIOS,
  IMAGE_ERRORS,
} from './blog-image-generator.service';

export const MAX_EDIT_MARKDOWN = 8000;
const MAX_TITLE = 150;

/**
 * What the editor answers after the user accepts or rejects a change. A
 * rejected change may carry the user's reason.
 */
const editorOutput = z.object({
  applied: z.boolean(),
  error: z.enum(['NO_SELECTION', 'NOT_FOUND', 'AMBIGUOUS', 'STALE']).optional(),
  reason: z.string().max(500).optional(),
});
export type EditorToolOutput = z.infer<typeof editorOutput>;

const markdown = z.string().min(1).max(MAX_EDIT_MARKDOWN);

/**
 * Editor tools have no `execute`: the stream ends at the call, the browser
 * shows the change for the user to accept or reject, applies it to its own
 * editor and sends the outcome back with `addToolOutput`. Nothing is saved
 * here; the user saves the blog as usual.
 */
export const editorTools = {
  replaceSelection: tool({
    description:
      'Replace the text the user has selected in the editor with new Markdown. Prefer this whenever <selection> is present and the request is about it.',
    inputSchema: z.object({
      markdown: markdown.describe('The replacement for the whole selection'),
    }),
    outputSchema: editorOutput,
  }),
  replaceText: tool({
    description:
      'Replace one passage of the draft. `find` must be copied exactly from <draft> and occur there once; keep it short but unique (a sentence or a paragraph).',
    inputSchema: z.object({
      find: z.string().min(1).max(MAX_EDIT_MARKDOWN),
      replace: z.string().max(MAX_EDIT_MARKDOWN),
    }),
    outputSchema: editorOutput,
  }),
  insertMarkdown: tool({
    description:
      'Insert new Markdown into the draft: at the cursor, at the end, or right after a passage copied exactly from <draft>.',
    inputSchema: z.object({
      markdown,
      position: z.enum(['cursor', 'end', 'after']),
      after: z
        .string()
        .max(MAX_EDIT_MARKDOWN)
        .optional()
        .describe('Required when position is "after"'),
    }),
    outputSchema: editorOutput,
  }),
  setTitle: tool({
    description: 'Propose a new title for the blog.',
    inputSchema: z.object({ title: z.string().min(1).max(MAX_TITLE) }),
    outputSchema: editorOutput,
  }),
  insertImage: tool({
    description:
      'Insert an image into the draft, or swap one already there for it (`replaces`). The only way to add or change an image: never put image Markdown in the other editor tools. Only use a URL returned by generateImage or editImage, copied exactly: never change its scheme, host or path.',
    inputSchema: z.object({
      // storage serves plain http outside production, e.g. localhost:9000
      url: z.url({ protocol: /^https?$/ }),
      alt: z
        .string()
        .min(1)
        .max(200)
        .describe('Short description, in the language of the draft'),
      position: z.enum(['cursor', 'end', 'after']),
      after: z.string().max(MAX_EDIT_MARKDOWN).optional(),
      replaces: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'URL of an image in <draft> that this one takes the place of, copied exactly; position is then ignored',
        ),
    }),
    outputSchema: editorOutput,
  }),
};

const imageOutput = z.union([
  z.object({ url: z.string() }),
  z.object({ error: z.enum(IMAGE_ERRORS) }),
]);

export function blogAssistantTools(
  userId: string,
  knowledge: KnowledgeSearchService,
  images: BlogImageGeneratorService,
) {
  return {
    ...editorTools,
    searchKnowledge: searchKnowledgeTool(knowledge),
    generateImage: tool({
      description:
        "Generate a new illustration for the blog and store it. Costs one of the user's daily images: only call it when the user asks for an image. Write the prompt in English, describing a plant-based dish or scene (subject, angle, lighting, style); no text in the image, no real people. Returns a URL to pass to insertImage, or an error code to explain to the user.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(1000),
        aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).default('4:3'),
      }),
      outputSchema: imageOutput,
      execute: ({ prompt, aspectRatio }, { abortSignal }) =>
        images.generate(userId, prompt, aspectRatio, abortSignal),
    }),
    editImage: tool({
      description:
        "Edit an image already in the draft (one of the user's blog images) following an instruction, e.g. brighter, remove the spoon, change the background. Costs one daily image. Returns the edited image's URL; the original is kept, so call insertImage with `replaces` set to the original URL to swap them.",
      inputSchema: z.object({
        imageUrl: z.url(),
        instruction: z.string().min(1).max(1000).describe('In English'),
      }),
      outputSchema: imageOutput,
      execute: ({ imageUrl, instruction }, { abortSignal }) =>
        images.edit(userId, imageUrl, instruction, abortSignal),
    }),
  };
}

export type BlogAssistantTools = ReturnType<typeof blogAssistantTools>;
