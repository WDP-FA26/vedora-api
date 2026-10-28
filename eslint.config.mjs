import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    ...vitest.configs.recommended,
    rules: {
      ...vitest.configs.recommended.rules,
      // `expect(mock.method).toHaveBeenCalled()` passes a method unbound on
      // purpose; Vitest has no type-aware replacement for this rule.
      '@typescript-eslint/unbound-method': 'off',
      // supertest's `.expect(status)` is an assertion too.
      'vitest/expect-expect': [
        'error',
        {
          assertFunctionNames: ['expect', 'request.**.expect', '**.expect'],
        },
      ],
    },
  },
  // Paths retired by the refactors, so they do not creep back.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/post-search/**'],
              message: 'Post search now lives in src/posts/search.',
            },
            {
              group: ['**/ai-usage/**'],
              message: 'AI usage now lives in src/ai/usage.',
            },
            {
              group: ['**/posts/ai/**'],
              message: 'Blog AI now lives in src/posts/blogs/ai.',
            },
          ],
        },
      ],
    },
  },
  // The shared AI platform must not depend on any feature: features use it,
  // never the other way round.
  {
    files: ['src/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/post-search/**'],
              message: 'Post search now lives in src/posts/search.',
            },
            {
              group: ['**/ai-usage/**'],
              message: 'AI usage now lives in src/ai/usage.',
            },
            {
              group: ['**/posts/ai/**'],
              message: 'Blog AI now lives in src/posts/blogs/ai.',
            },
            {
              group: [
                '**/auth/**',
                '**/users/**',
                '**/profiles/**',
                '**/posts/**',
                '**/media/**',
                '**/recipes/**',
                '**/meal-plan/**',
                '**/nutrition-chat/**',
                '**/payments/**',
                '**/notifications/**',
                '**/verification/**',
                '**/admin-dashboard/**',
                '**/storage/**',
                '**/cloudinary/**',
                '**/mail/**',
                '**/qdrant/**',
                '**/database/**',
              ],
              message:
                'src/ai is shared infrastructure; features depend on it, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  // Config only validates environment variables; it must not pull in a
  // feature module (the old nutrition-chat enum import was exactly that).
  {
    files: ['src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/post-search/**'],
              message: 'Post search now lives in src/posts/search.',
            },
            {
              group: ['**/ai-usage/**'],
              message: 'AI usage now lives in src/ai/usage.',
            },
            {
              group: ['**/posts/ai/**'],
              message: 'Blog AI now lives in src/posts/blogs/ai.',
            },
            {
              group: [
                '**/auth/**',
                '**/users/**',
                '**/profiles/**',
                '**/posts/**',
                '**/media/**',
                '**/recipes/**',
                '**/meal-plan/**',
                '**/nutrition-chat/**',
                '**/payments/**',
                '**/notifications/**',
                '**/verification/**',
                '**/admin-dashboard/**',
                '**/knowledge/**',
                '**/storage/**',
                '**/cloudinary/**',
                '**/qdrant/**',
                '**/mail/**',
              ],
              message:
                'src/config only reads environment variables; features depend on config, not the other way round.',
            },
          ],
        },
      ],
    },
  },
);
