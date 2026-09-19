/**
 * scripts/run-tests.js
 * Runs the node:test suites under tests/ (or a sub-directory passed as the
 * first argument, e.g. `node scripts/run-tests.js tests/ai`).
 *
 * Why not `node --test tests/`? On Node >= 21 a bare directory argument is
 * treated as a module path and fails, while glob patterns are not supported
 * on Node 20. Passing an explicit file list works on every supported version.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.resolve(root, process.argv[2] || 'tests');

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collect(full);
    return /\.test\.js$/.test(entry.name) ? [full] : [];
  });
}

const files = collect(target).sort();
if (files.length === 0) {
  console.log(`[tests] no *.test.js files found under ${path.relative(root, target) || '.'}`);
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status === null ? 1 : result.status);
