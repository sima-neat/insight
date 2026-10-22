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

module.exports = defineConfig([
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
              group: ['@spartan-ng/*', '@lucide/*', 'primeng/*', '@primeuix/*'],
              message: KIT_ONLY_MESSAGE,
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
