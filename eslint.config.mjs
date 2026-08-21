import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * One flat config for the whole monorepo.
 *
 * `next lint` was removed in Next 16, and per-package ESLint installs in a
 * pnpm workspace mean nine copies of the same config drifting apart. A single
 * root config linted by `pnpm lint` is both what Next now recommends and the
 * only arrangement where "the lint step actually lints everything" is
 * verifiable rather than assumed.
 *
 * Type-aware rules are deliberately not enabled globally: they need a program
 * per tsconfig and would triple CI time for rules that mostly duplicate what
 * `tsc --noEmit` already rejects under this repo's strict settings. The rules
 * kept here are the ones a typechecker cannot see.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/drizzle/meta/**',
      'pnpm-lock.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // The codebase uses `_`-prefixed parameters for deliberately unused
      // arguments (Fastify handlers, React props). Honour that convention
      // rather than forcing `void x` noise.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // `any` defeats the strict tsconfig this repo relies on for its tenant
      // and content boundaries; `unknown` plus a parse is the house style.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // dangerouslySetInnerHTML is legitimate in exactly two places, both
          // of which opt in with an eslint-disable and a comment saying which
          // sanitiser produced the string. Everywhere else it is a finding.
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'dangerouslySetInnerHTML must be justified: the value has to come from @bos/sanitize or serialiseJsonLd. Disable this rule inline with a comment naming the source.',
        },
      ],
    },
  },

  // Cloudflare Workers run in a browser-like runtime, not Node.
  {
    files: ['apps/edge/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
  },

  // The two Next applications.
  {
    files: ['apps/site/**/*.{ts,tsx}', 'apps/dashboard/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,

      /*
       * Both applications are App Router only. This rule looks for a `pages/`
       * directory, does not find one, and prints an advisory line on every
       * run — noise that trains people to ignore lint output.
       */
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Scripts and tests are allowed to talk to the operator.
  {
    files: ['**/scripts/**/*.ts', '**/tests/**/*.ts', 'scripts/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
);
