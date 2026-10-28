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
);
