import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  // Build output, and locally-rendered digests that contain real email content.
  globalIgnores(['dist/**', 'previews/**']),

  {
    name: 'gmail-digest/base',
    // Everything is ESM on Node: src/, scripts/ (CLI), test/ (node:test).
    // node:test and node:assert are imported explicitly, so tests need no extra globals.
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      // A stale eslint-disable is a lie about the code.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // --- correctness ---
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `x != null` is a deliberate null-or-undefined check here; everything else is strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-shadow': 'error',
      'require-atomic-updates': 'error',
      'consistent-return': 'error',
      'no-promise-executor-return': 'error',
      'require-await': 'error',
      'array-callback-return': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-constructor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      radix: 'error',

      // --- never in this codebase ---
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-extend-native': 'error',
      'no-proto': 'error',
      'no-caller': 'error',
      'no-script-url': 'error',
      'no-var': 'error',

      // --- modern-syntax hygiene (all autofixable) ---
      'prefer-const': 'error',
      'no-implicit-coercion': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-object-spread': 'error',
      'no-useless-rename': 'error',
      'no-useless-concat': 'error',
      'no-useless-return': 'error',
      'prefer-regex-literals': 'error',
      'dot-notation': 'error',
      curly: ['error', 'multi-line'],

      // console IS the log here: CloudWatch for the Lambda, stdout for the CLI scripts.
      'no-console': 'off',
    },
  },

  {
    // The Lambda bundle must never reach into CLI-only helpers.
    name: 'gmail-digest/src-boundary',
    files: ['src/**/*.mjs'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/scripts/*'], message: 'src/ must not import CLI scripts.' }] },
      ],
      // no-restricted-imports only sees static imports, so close the import() gap too.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/(^|\\/)scripts\\//]',
          message: 'src/ must not import CLI scripts.',
        },
      ],
    },
  },
]);
