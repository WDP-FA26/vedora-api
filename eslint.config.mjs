import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';
import tseslint from 'typescript-eslint';

const retiredPathPatterns = [
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
];

const providerInternalPatterns = [
  {
    group: ['**/ai/providers/gateway/**', '**/ai/providers/openrouter/**'],
    message:
      'Import from src/ai/providers/provider-registry or ai-provider.interface instead of concrete provider adapters.',
  },
];

const aiSharedLayerGroup = [
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
  '**/knowledge/**',
  '**/cloudinary/**',
  '**/mail/**',
  '**/qdrant/**',
  '**/database/**',
];

const featureGroups = [
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
  '**/webhooks/**',
  '**/moderation/**',
];

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
      'no-empty': ['error', { allowEmptyCatch: true }],
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
      '@typescript-eslint/unbound-method': 'off',
      'vitest/expect-expect': [
        'error',
        {
          assertFunctionNames: ['expect', 'request.**.expect', '**.expect'],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/ai/providers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...retiredPathPatterns, ...providerInternalPatterns],
        },
      ],
    },
  },
  {
    files: ['src/ai/**/*.ts'],
    ignores: ['src/ai/providers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            ...providerInternalPatterns,
            {
              group: aiSharedLayerGroup,
              message:
                'src/ai is shared infrastructure; features depend on it, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/ai/providers/ai-provider.interface.ts',
      'src/ai/providers/provider-shared.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            ...providerInternalPatterns,
            {
              group: aiSharedLayerGroup,
              message:
                'src/ai is shared infrastructure; features depend on it, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ai/providers/provider-registry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            {
              group: aiSharedLayerGroup,
              message:
                'src/ai is shared infrastructure; features depend on it, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ai/providers/gateway/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            {
              group: ['**/providers/openrouter/**', '../openrouter/**'],
              message:
                'Gateway adapter must stay completely independent of OpenRouter.',
            },
            {
              group: aiSharedLayerGroup,
              message:
                'src/ai is shared infrastructure; features depend on it, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ai/providers/openrouter/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            {
              group: ['**/providers/gateway/**', '../gateway/**'],
              message:
                'OpenRouter adapter must stay completely independent of Gateway.',
            },
            {
              group: aiSharedLayerGroup,
              message:
                'src/ai is shared infrastructure; features depend on it, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            ...providerInternalPatterns,
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
  {
    files: [
      'src/auth-core/**/*.ts',
      'src/captcha/**/*.ts',
      'src/storage/**/*.ts',
      'src/mongo/**/*.ts',
      'src/common/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...retiredPathPatterns,
            ...providerInternalPatterns,
            {
              group: featureGroups,
              message:
                'auth-core, captcha, storage, mongo and common are shared layers; features depend on them, not the other way round.',
            },
          ],
        },
      ],
    },
  },
);
