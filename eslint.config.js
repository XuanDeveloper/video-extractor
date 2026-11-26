import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['extension/src/vendor/**', 'node_modules/**', 'dist/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  // Extension: service worker, popup and offscreen document are ES modules.
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['extension/src/offscreen/**/*.js', 'extension/src/lib/player.js'],
    languageOptions: { globals: { Hls: 'readonly', dashjs: 'readonly' } },
  },
  // Content scripts are classic scripts injected into pages.
  {
    files: ['extension/src/content/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions, module: 'writable' } },
  },
  {
    files: ['scripts/**', 'tests/**', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  // Code passed to page.evaluate()/sw.evaluate() runs in the browser.
  {
    files: ['tests/e2e/**'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
];
