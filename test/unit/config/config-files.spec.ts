import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadJsonConfig,
  loadTextConfig,
  validContentPolicy,
  validDecisionPolicy,
} from '@src/config/config-files.js';

describe('external prompt and policy files', () => {
  it('preserves the three policy objects extracted from the original source', () => {
    const entries = JSON.parse(
      readFileSync(
        new URL(
          '../../fixtures/prompt-policy-before-refactor.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { file: string; sha256: string; upstreamSha256?: string }[];
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      const source = readFileSync(entry.file, 'utf8');
      const value = entry.file.endsWith('.json')
        ? JSON.stringify(JSON.parse(source))
        : source;
      expect(createHash('sha256').update(value).digest('hex')).toBe(
        entry.upstreamSha256 ?? entry.sha256,
      );
    }
  });

  it('loads a custom file and rejects missing, blank, malformed and structurally invalid files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vedora-env-policy-'));
    const file = join(directory, 'policy.json');
    try {
      expect(() => loadTextConfig(file)).toThrow('cannot be read');
      writeFileSync(file, '  \n');
      expect(() => loadTextConfig(file)).toThrow('empty');
      writeFileSync(file, '{broken');
      expect(() => loadJsonConfig(file, validContentPolicy)).toThrow(
        'Invalid JSON',
      );
      writeFileSync(file, '{}');
      expect(() => loadJsonConfig(file, validContentPolicy)).toThrow(
        'Invalid config file structure',
      );
      const policy = {
        type: 'choice',
        instructions: 'Custom moderation',
        criteria: { allow: 'Relevant', deny: 'Unsafe' },
      };
      writeFileSync(file, JSON.stringify(policy));
      expect(
        loadJsonConfig(file, (value) =>
          validDecisionPolicy(value, ['allow', 'deny']),
        ),
      ).toEqual(policy);
      expect(() =>
        loadJsonConfig(file, (value) =>
          validDecisionPolicy(value, ['allow', 'different']),
        ),
      ).toThrow('Invalid config file structure');
      expect(
        validContentPolicy({
          instructions: 'custom',
          allowDescription: 'allowed',
          choices: [
            {
              key: 'unsafe',
              label: 'Unsafe',
              description: 'Unsafe content',
              reasonText: 'Please revise',
            },
            {
              key: 'unsafe',
              label: 'Duplicate',
              description: 'Duplicate category',
              reasonText: 'Please revise',
            },
          ],
        }),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
