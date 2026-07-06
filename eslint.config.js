// ---------------------------------------------------------------------------
// ESLint flat config (ESLint 9+). The chosen rule set:
//
// - typescript-eslint recommended           — catches real TS bugs
// - react-hooks recommended                 — enforces the rules of hooks
// - react-refresh only-export-components    — keeps HMR working
// - jsx-a11y recommended                    — accessibility gates the auth
//                                             pages (WCAG 2.1 AA target)
//
// Notable extras:
// - `no-console` warns. Production code should not ship console.log.
//   Tests and src/test/** are excluded.
// - `no-restricted-globals` blocks `localStorage` / `sessionStorage` /
//   `document.cookie` direct access outside the storage abstraction layer.
//   This is a defense-in-depth measure: any place we touch persistent
//   storage should be auditable + centralized.
// ---------------------------------------------------------------------------

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Browser-storage guardrails. Amplify v6 owns auth-token persistence;
      // any *other* persistent state should go through a small abstraction
      // (not yet written) so we have one place to swap storage strategy if
      // the threat model evolves (e.g. cookieStorage instead of localStorage).
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message:
            'Direct browser-storage access is discouraged. Amplify owns auth-token persistence; add a thin storage abstraction for any other persistent state.',
        },
        {
          name: 'sessionStorage',
          message:
            'Direct browser-storage access is discouraged. Amplify owns auth-token persistence; add a thin storage abstraction for any other persistent state.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='document'][property.name='cookie']",
          message: 'Direct cookie access is discouraged. Auth tokens are owned by Amplify v6.',
        },
      ],
    },
  },
  {
    // Tests have looser rules — console output, any-types in mocks, etc.
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
