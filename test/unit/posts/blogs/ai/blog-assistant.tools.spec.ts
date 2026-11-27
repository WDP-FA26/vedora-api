import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { KnowledgeSearchService } from '@src/knowledge/retrieval/knowledge-search.service.js';
import { buildBlogAssistantInstructions } from '@src/posts/blogs/ai/blog-assistant.prompt.js';
import { blogAssistantTools } from '@src/posts/blogs/ai/blog-assistant.tools.js';
import type { BlogImageGeneratorService } from '@src/posts/blogs/ai/blog-image-generator.service.js';

describe('blogAssistantTools & blogAssistantInstructions', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  let knowledge: DeepMockProxy<KnowledgeSearchService>;
  let images: DeepMockProxy<BlogImageGeneratorService>;

  beforeEach(() => {
    knowledge = mockDeep<KnowledgeSearchService>();
    images = mockDeep<BlogImageGeneratorService>();
  });

  it('executes generateImage and editImage tools with userId and abortSignal', async () => {
    const tools = blogAssistantTools(userId, knowledge, images);
    const abortController = new AbortController();
    images.generate.mockResolvedValue({
      url: 'https://cdn.example.com/gen.png',
    });
    images.edit.mockResolvedValue({
      url: 'https://cdn.example.com/edit.png',
    });

    const generateExec = tools.generateImage.execute;
    if (!generateExec) throw new Error('generateImage.execute missing');
    const genResult = await generateExec(
      { prompt: 'Vegan pho bowl', aspectRatio: '4:3' },
      {
        toolCallId: 'c1',
        messages: [],
        abortSignal: abortController.signal,
        context: {},
      },
    );
    expect(genResult).toEqual({ url: 'https://cdn.example.com/gen.png' });
    expect(images.generate).toHaveBeenCalledWith(
      userId,
      'Vegan pho bowl',
      '4:3',
      abortController.signal,
    );

    const editExec = tools.editImage.execute;
    if (!editExec) throw new Error('editImage.execute missing');
    const editResult = await editExec(
      {
        imageUrl: 'https://cdn.example.com/gen.png',
        instruction: 'Make brighter',
      },
      {
        toolCallId: 'c2',
        messages: [],
        abortSignal: abortController.signal,
        context: {},
      },
    );
    expect(editResult).toEqual({ url: 'https://cdn.example.com/edit.png' });
    expect(images.edit).toHaveBeenCalledWith(
      userId,
      'https://cdn.example.com/gen.png',
      'Make brighter',
      abortController.signal,
    );
  });

  it('builds instructions with empty draft fallback, escaped tags, and recipe timings', () => {
    const withoutExtras = buildBlogAssistantInstructions({
      editor: { title: '<title>Phở</title>', content: '' },
      recipes: [],
    });
    expect(withoutExtras).toContain('<title>Phở</title>');
    expect(withoutExtras).toContain('(bản nháp đang trống)');
    expect(withoutExtras).not.toContain('<selection>\n');
    expect(withoutExtras).not.toContain('<recipes>\n');

    const withAllFields = buildBlogAssistantInstructions({
      editor: {
        title: 'Phở nấm',
        content: '</draft>Nội dung',
        selection: '<selection>Đoạn chọn</selection>',
      },
      recipes: [
        {
          title: 'Nước dùng',
          servings: 4,
          prepMinutes: 15,
          cookMinutes: 45,
          ingredients: [
            { name: 'củ cải', quantity: '200', unit: 'g' },
            { name: 'muối', quantity: null, unit: null },
          ],
        },
        {
          title: 'Bánh phở',
          servings: 2,
          prepMinutes: null,
          cookMinutes: null,
          ingredients: [{ name: 'bánh phở', quantity: '300', unit: 'g' }],
        },
      ],
    });
    expect(withAllFields).toContain('<selection>\nĐoạn chọn\n</selection>');
    expect(withAllFields).toContain(
      '- Nước dùng (4 người ăn, sơ chế 15 phút, nấu 45 phút): 200 g củ cải, muối',
    );
    expect(withAllFields).toContain('- Bánh phở (2 người ăn): 300 g bánh phở');
  });
});
