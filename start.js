/**
 * start.js
 * -----------------------------------------------------------------------
 * One-command launcher: `npm start` (or `node start.js`).
 *
 * Installs dependencies if node_modules is missing, boots the backend
 * (server.js — which also serves the frontend from ./public and streams
 * telemetry over Socket.IO), waits for it to come up, then opens the
 * dashboard in the default browser. Everything runs on the single port
 * server.js listens on (PORT env var, default 5000) — there is no
 * separate frontend process to manage.
 * -----------------------------------------------------------------------
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 5000;
const URL = `http://localhost:${PORT}`;

function ensureDependencies() {
  const nodeModules = path.join(__dirname, 'node_modules');
  if (fs.existsSync(nodeModules)) return;

  console.log('[start] node_modules not found — running npm install...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['install'], { stdio: 'inherit', cwd: __dirname });
  if (result.status !== 0) {
    console.error('[start] npm install failed');
    process.exit(result.status || 1);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

function waitForServer(url, onReady) {
  const attempt = () => {
    const req = http.get(url, (res) => {
      res.resume();
      onReady();
    });
    req.on('error', () => setTimeout(attempt, 300));
  };
  attempt();
}

ensureDependencies();

console.log('[start] launching backend + frontend (server.js)...');
const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  cwd: __dirname,
});

waitForServer(`${URL}/api/health`, () => {
  console.log(`[start] server is up — opening ${URL}`);
  openBrowser(URL);
});

server.on('exit', (code) => process.exit(code === null ? 0 : code));

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    server.kill(sig);
  });
});
