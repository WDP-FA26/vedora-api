import { DocumentExtractor } from './document-extractor';
import { DocumentExtractorRegistry } from './document-extractor.registry';

class FakeExtractor extends DocumentExtractor {
  constructor(readonly formats: DocumentExtractor['formats']) {
    super();
  }

  extract() {
    return Promise.resolve([{ text: 'text', images: [] }]);
  }
}

describe('DocumentExtractorRegistry', () => {
  const pdf = new FakeExtractor([
    { contentType: 'application/pdf', extension: 'pdf' },
  ]);
  const markdown = new FakeExtractor([
    { contentType: 'text/markdown', extension: 'md' },
  ]);
  const registry = new DocumentExtractorRegistry([pdf, markdown]);

  it('matches file names by extension, ignoring case', () => {
    expect(registry.formatFor('Dinh Duong.PDF')).toEqual({
      contentType: 'application/pdf',
      extension: 'pdf',
    });
    expect(registry.formatFor('notes.md')?.contentType).toBe('text/markdown');
  });

  it('rejects unknown or missing extensions', () => {
    expect(registry.formatFor('photo.jpg')).toBeUndefined();
    expect(registry.formatFor('README')).toBeUndefined();
  });

  it('routes a content type to its extractor', () => {
    expect(registry.extractorFor('text/markdown')).toBe(markdown);
    expect(registry.extractorFor('image/png')).toBeUndefined();
    expect(registry.extensions).toEqual(['pdf', 'md']);
  });
});
