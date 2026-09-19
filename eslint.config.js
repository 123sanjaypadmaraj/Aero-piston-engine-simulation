'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'twin_core/data/**',
      'public/vendor/**',
      'coverage/**',
      'logs/**',
    ],
  },
  js.configs.recommended,
  {
    // Server-side code, scripts and config: CommonJS on Node.
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Browser code served from public/js (classic scripts by default).
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Chart: 'readonly', // Chart.js (loaded via <script>)
        io: 'readonly',    // Socket.IO client (served at /socket.io/socket.io.js)
      },
    },
  },
  {
    // twin3d.js is an ES module (imports three.js from /vendor/three).
    files: ['public/js/twin3d.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Tests run under node:test.
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
