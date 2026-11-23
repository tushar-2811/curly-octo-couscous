import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-dev/**',
      '**/coverage/**',
      'apps/worker/workflow-bundle.js',
      'apps/dashboard/next-env.d.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Logs go through the structured logger, never console (scripts and the dashboard's
      // own JSON logger are exempt below).
      'no-console': 'error',
    },
  },

  // Module boundaries (Technical architecture §2). Shared packages never depend on apps,
  // and the dashboard never touches the database or backend internals: it only calls the API.
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aiw/web', '@aiw/worker', '@aiw/egress', '@aiw/dashboard'],
              message: 'Packages must not import apps.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'apps/dashboard' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aiw/db', '@aiw/web', '@aiw/worker', '@aiw/egress', 'pg', 'kysely'],
              message: 'The dashboard talks to the API, never to the database or backend code.',
            },
          ],
        },
      ],
    },
  },
  {
    // Workflow code runs in Temporal's deterministic sandbox: no I/O or shared packages.
    files: ['apps/worker/src/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aiw/*', 'node:*', 'pg', 'kysely', 'fs', 'http', 'https'],
              message: 'Workflows must be deterministic; do I/O in activities.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'apps/dashboard/lib/server-log.ts',
      'apps/dashboard/instrumentation.ts',
      'apps/worker/scripts/**',
      'scripts/**',
    ],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
