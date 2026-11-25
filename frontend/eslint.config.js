// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

// The app gets its UI only from @sima/neat-ui, so the kit's underlying libraries can be swapped
// without touching the app (see AGENTS.md). These are the libraries the kit is built on, plus
// PrimeNG, which the kit replaced and whose licence rules it out.
const KIT_ONLY_MESSAGE =
  'Import UI from @sima/neat-ui. If it lacks what you need, propose a kit change (see AGENTS.md).';

// `ɵ` names are the kit's shared internals, exported from the primary entry point only so its other
// entry points can reach them. They carry no stability promise and change without notice.
const KIT_INTERNALS_MESSAGE =
  "Names starting with ɵ are the kit's internals, not its public API. If you need one, propose a kit change (see AGENTS.md).";

module.exports = defineConfig([
  // Written by `npm run api:types` from the server's API document, never by hand; `check:api`
  // (part of `npm run lint`) fails when it differs from what the document makes.
  { ignores: ['src/app/api.generated.ts'] },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // Component styles live in .css files (styleUrl) because Stylelint reads only stylesheets:
      // an inline `styles` block would escape the colour-literal rules. Inline templates stay
      // allowed at any length; the rule has no off switch per kind, hence the unreachable limit.
      '@angular-eslint/component-max-inline-declarations': [
        'error',
        { template: Number.MAX_SAFE_INTEGER, styles: 0 },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'class-variance-authority', message: KIT_ONLY_MESSAGE },
            { name: 'clsx', message: KIT_ONLY_MESSAGE },
            { name: 'tailwind-merge', message: KIT_ONLY_MESSAGE },
            { name: 'primeng', message: KIT_ONLY_MESSAGE },
          ],
          patterns: [
            {
              group: ['@spartan-ng/*', '@lucide/*', 'primeng/*', '@primeuix/*', 'd3', 'd3-*'],
              message: KIT_ONLY_MESSAGE,
            },
            {
              group: ['@sima/neat-ui', '@sima/neat-ui/*'],
              importNamePattern: '^ɵ',
              message: KIT_INTERNALS_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
]);
