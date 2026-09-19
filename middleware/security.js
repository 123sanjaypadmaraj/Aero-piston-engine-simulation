/**
 * middleware/security.js
 * -----------------------------------------------------------------------
 * helmet (CSP tuned to what public/index.html actually loads), CORS
 * allowlist (Express + Socket.IO), rate limiting, and the optional
 * ADMIN_API_KEY guard for mutating routes.
 * -----------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('./errors');

/**
 * index.html carries an inline <script type="importmap"> (maps "three" to
 * /vendor/three). CSP script-src has no way to allow it without either
 * 'unsafe-inline' or a hash, so we hash every inline <script> in the served
 * HTML at startup; the policy then tracks the file automatically.
 */
function inlineScriptHashes(publicDir) {
  try {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const hashes = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (m[1].trim()) hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

function helmetMiddleware({ isProduction, publicDir }) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // Chart.js from cdnjs; socket.io client, app.js, twin3d.js and three.js are all same-origin.
        'script-src': ["'self'", 'https://cdnjs.cloudflare.com', ...inlineScriptHashes(publicDir)],
        // Google Fonts stylesheet. No inline <style> blocks in the page; style attributes
        // (set via JS/three/Chart.js) are permitted separately below.
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'style-src-attr': ["'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // data: for the emoji favicon and canvas/texture data URIs, blob: for three.js textures.
        'img-src': ["'self'", 'data:', 'blob:'],
        // Socket.IO polling (same-origin fetch/XHR) and websocket upgrade (ws:/wss:).
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'worker-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // Only meaningful over HTTPS; TLS is expected to be terminated by a reverse proxy.
    strictTransportSecurity: isProduction,
    crossOriginEmbedderPolicy: false,
  });
}

/** True if the Origin header names the same host the request was sent to. */
function isSameOrigin(origin, hostHeader) {
  try {
    return Boolean(hostHeader) && new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

/** True if a request bearing this Origin header may be served. */
function originAllowed(origin, hostHeader, corsOrigins) {
  if (!origin) return true; // non-browser client or same-origin navigation
  if (corsOrigins === null) return true; // permissive (development / CORS_ORIGIN=*)
  if (corsOrigins.includes(origin)) return true;
  return isSameOrigin(origin, hostHeader);
}

function corsMiddleware(corsOrigins) {
  if (corsOrigins === null) return cors();
  return cors((req, cb) => {
    const origin = req.headers.origin;
    // Reflect ACAO only for allowlisted origins; same-origin requests never need it.
    cb(null, { origin: Boolean(origin) && corsOrigins.includes(origin) });
  });
}

/** Options for `new Server(httpServer, ...)`: same allowlist as Express, enforced on the upgrade too. */
function socketIoOptions(corsOrigins) {
  return {
    cors: corsOrigins === null ? { origin: '*' } : { origin: corsOrigins.length ? corsOrigins : false },
    // CORS headers do not gate websocket upgrades, so enforce the allowlist here as well.
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host, corsOrigins)),
    maxHttpBufferSize: 1e5,
  };
}

function limiter({ windowMs, limit, message, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip,
    handler: (_req, res) => {
      res.status(429).json({ error: 'too many requests', detail: message });
    },
  });
}

function rateLimiters({ rateLimit: rl }) {
  return {
    general: limiter({
      windowMs: rl.windowMs,
      limit: rl.max,
      message: `limit of ${rl.max} requests per ${Math.round(rl.windowMs / 1000)}s exceeded`,
    }),
    heavy: limiter({
      windowMs: rl.windowMs,
      limit: rl.heavyMax,
      message: `limit of ${rl.heavyMax} expensive operations per ${Math.round(rl.windowMs / 1000)}s exceeded`,
    }),
  };
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

/**
 * When ADMIN_API_KEY is set, every mutating request (POST/PUT/PATCH/DELETE)
 * must carry a matching `x-api-key` header. Both sides are hashed first so
 * timingSafeEqual gets equal-length buffers and length is not leaked.
 */
function adminGuard(adminApiKey) {
  if (!adminApiKey) return (_req, _res, next) => next();
  const expected = sha256(adminApiKey);
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const provided = req.headers['x-api-key'];
    if (typeof provided === 'string' && crypto.timingSafeEqual(sha256(provided), expected)) return next();
    return next(new HttpError(401, 'unauthorized', 'a valid x-api-key header is required for this operation'));
  };
}

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  socketIoOptions,
  rateLimiters,
  adminGuard,
  originAllowed,
  inlineScriptHashes,
};
