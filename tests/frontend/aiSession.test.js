/**
 * tests/frontend/aiSession.test.js
 * ---------------------------------------------------------------------------
 * Tests for the memory-only, session-scoped AI provider override
 * (public/js/aiSession.js) and its static contract with index.html.
 *
 * The whole point of this module is that it may NOT persist anything, so the
 * tests assert the absence of every storage API: no localStorage,
 * sessionStorage, cookies, IndexedDB, or writes of any kind. The key exists
 * only in the module closure and is delivered to the server per-request as a
 * plain header.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'aiSession.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** Load aiSession.js in a sandbox and return its window.DtAiSession export. */
function loadSession() {
  const sandbox = {
    console,
    window: {},
    localStorage: undefined,
    sessionStorage: undefined,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'aiSession.js' });
  return sandbox.window.DtAiSession;
}

function asPlainObject(o) {
  return typeof o === 'object' && o !== null ? JSON.parse(JSON.stringify(o)) : o;
}

test('exposes the expected surface and starts inactive', () => {
  const s = loadSession();
  for (const fn of ['set', 'clear', 'active', 'headers', 'provider']) {
    assert.equal(typeof s[fn], 'function', `${fn} is a function`);
  }
  assert.equal(s.active(), false);
  assert.deepEqual(asPlainObject(s.headers()), {});
  assert.equal(s.provider(), '');
});

test('set/clear lifecycle: valid keys work, invalid ones are rejected', () => {
  const s = loadSession();
  assert.equal(s.set('gemini', 'AIza-'.padEnd(25, 'x')), true);
  assert.equal(s.active(), true);
  assert.equal(s.provider(), 'gemini');
  const h = s.headers();
  assert.equal(h['x-ai-provider'], 'gemini');
  assert.equal(h['x-ai-api-key'], 'AIza-'.padEnd(25, 'x'));

  assert.equal(s.set('groq', 'x'), false, 'short key rejected');
  assert.equal(s.set('openai', 'sk-'.padEnd(25, 'x')), false, 'unknown provider rejected');
  assert.equal(s.set('GROQ', 'gsk_'.padEnd(25, 'x')), true, 'provider name normalized');

  assert.equal(s.clear(), true, 'cleared something');
  assert.equal(s.active(), false);
  assert.deepEqual(asPlainObject(s.headers()), {});
  assert.equal(s.clear(), false, 'second clear is a no-op');
});

test('source uses no storage or network APIs of any kind (only the closure + the export)',
  () => {
    // The file may NAME these APIs in comments; what it must never do is call
    // them, so check for call sites and property accesses.
    for (const token of [
      'localStorage.', 'sessionStorage.', 'window.localStorage', 'window.sessionStorage',
      'document.cookie', 'indexedDB', 'fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'WebSocket',
    ]) {
      assert.ok(!SRC.includes(token), `must not reference ${token}`);
    }
  }
);

test('the key is never exposed on the window object', () => {
  const sandbox = { console, window: {} };
  sandbox.window.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'aiSession.js' });
  const s = sandbox.window.DtAiSession;
  const key = 'AIza-'.padEnd(25, 'x');
  s.set('gemini', key);
  const leaked = Object.keys(sandbox.window).filter((k) => {
    const v = sandbox.window[k];
    return typeof v === 'string' && v.includes(key) ? k : null;
  });
  // Only the export object is on window; the key itself must not be a string property of it.
  assert.deepEqual(leaked, []);
  assert.equal(typeof s, 'object');
});

test('index.html loads aiSession.js before app.js and contains the panel ids', () => {
  const scriptIdx = INDEX_SRC.indexOf('js/aiSession.js');
  const appIdx = INDEX_SRC.indexOf('js/app.js');
  assert.ok(scriptIdx !== -1, 'aiSession.js script present');
  assert.ok(appIdx !== -1, 'app.js script present');
  assert.ok(scriptIdx < appIdx, 'aiSession.js loads before app.js');
  for (const id of ['aiSessionBox', 'aiSessProvider', 'aiSessKey', 'aiSessApply', 'aiSessClear', 'aiSessNote']) {
    assert.ok(INDEX_SRC.includes(`id="${id}"`), `index.html has #${id}`);
  }
});