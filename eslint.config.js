// -*- coding: utf-8 -*-
/**
 * eslint.config.js
 * TypeScript source validation
 * =====================
 * Configure syntax and type import checks for the workspace.
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/target/**', '**/node_modules/**', '**/.cache/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
);
