'use strict';

const http = require('node:http');
const { createServer } = require('../../server');

/** Stand-in for AiAnalysisEngine so tests never touch Gemini/Groq. */
function stubAi() {
  const calls = [];
  return {
    calls,
    latest: () => null,
    allLatest: () => ({}),
    onFleetTick: () => {},
    refresh: async (engine) => { calls.push(engine.id); return { text: 'stub', engineId: engine.id }; },
  };
}

/** Boots createServer() on an ephemeral loopback port with quiet logs. */
async function startTestServer(configOverrides = {}) {
  const ctx = createServer({
    config: { port: 0, host: '127.0.0.1', logLevel: 'silent', tickMs: 50, ...configOverrides },
    aiAnalysis: stubAi(),
  });
  const { port } = await ctx.start();
  return { ctx, port, base: `http://127.0.0.1:${port}` };
}

/** Minimal HTTP client (no keep-alive, arbitrary headers such as Origin). */
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

module.exports = { startTestServer, request, stubAi };
