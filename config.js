/**
 * config.js
 * -----------------------------------------------------------------------
 * Parses and validates the server's environment configuration exactly once
 * and exports it as a frozen object. Fails fast with a single message that
 * lists every problem, instead of surfacing bad values later as odd runtime
 * behaviour. Secrets (ADMIN_API_KEY) are never logged — see describe().
 *
 * Only the server-level variables live here. GEMINI_*, GROQ_*, AI_* and
 * TWIN_DATA_DIR are owned and read by their own modules.
 * -----------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();

const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function build(env) {
  const problems = [];
  const raw = (name) => (env[name] === undefined || env[name] === '' ? undefined : String(env[name]).trim());

  function int(name, def, min, max) {
    const v = raw(name);
    if (v === undefined) return def;
    if (!/^-?\d+$/.test(v)) {
      problems.push(`${name} must be an integer (got "${v}")`);
      return def;
    }
    const n = Number(v);
    if (n < min || n > max) {
      problems.push(`${name} must be between ${min} and ${max} (got ${n})`);
      return def;
    }
    return n;
  }

  const nodeEnv = raw('NODE_ENV') || 'development';
  const isProduction = nodeEnv === 'production';

  const port = int('PORT', 5000, 0, 65535); // 0 = ephemeral port (used by tests)
  const host = raw('HOST') || '0.0.0.0';

  // CORS_ORIGIN: comma-separated origin allowlist.
  //   unset -> same-origin only in production, permissive in development
  //   "*"   -> permissive (explicit opt-in)
  let corsOrigins = isProduction ? [] : null; // null = allow any origin
  const corsRaw = raw('CORS_ORIGIN');
  if (corsRaw !== undefined) {
    if (corsRaw === '*') {
      corsOrigins = null;
    } else {
      corsOrigins = [];
      for (const item of corsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
        try {
          const u = new URL(item);
          if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
          corsOrigins.push(u.origin);
        } catch {
          problems.push(`CORS_ORIGIN entry "${item}" is not a valid http(s) origin`);
        }
      }
    }
  }

  const rateLimit = {
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60000, 1000, 86400000),
    max: int('RATE_LIMIT_MAX', 120, 1, 1000000),
    heavyMax: int('RATE_LIMIT_HEAVY_MAX', 10, 1, 1000000),
  };

  const adminApiKey = raw('ADMIN_API_KEY') || null;
  if (adminApiKey && adminApiKey.length < 8) problems.push('ADMIN_API_KEY must be at least 8 characters when set');

  const logLevel = (raw('LOG_LEVEL') || 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join('|')} (got "${logLevel}")`);

  // TRUST_PROXY: "true" | "false" | hop count | Express subnet list ("loopback, 10.0.0.0/8")
  let trustProxy = false;
  const tp = raw('TRUST_PROXY');
  if (tp !== undefined) {
    if (/^true$/i.test(tp)) trustProxy = true;
    else if (/^false$/i.test(tp)) trustProxy = false;
    else if (/^\d+$/.test(tp)) trustProxy = Number(tp);
    else trustProxy = tp;
  }

  const config = {
    nodeEnv,
    isProduction,
    port,
    host,
    corsOrigins: corsOrigins === null ? null : Object.freeze(corsOrigins),
    rateLimit: Object.freeze(rateLimit),
    adminApiKey,
    logLevel,
    trustProxy,
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 10000, 100, 600000),
    // Further server-level knobs (not part of the documented minimum set).
    tickMs: int('TICK_MS', 2000, 50, 60000),
    socketMaxPerIp: int('SOCKET_MAX_PER_IP', 20, 1, 100000),
    socketMaxTotal: int('SOCKET_MAX_TOTAL', 500, 1, 1000000),
    maxConcurrentMissions: int('MAX_CONCURRENT_MISSIONS', 2, 1, 1000),
  };

  if (problems.length) throw new ConfigError(problems);
  return config;
}

const loadConfig = (env = process.env) => Object.freeze(build(env));

/** Human-readable, secret-free one-line summary for the startup log. */
function describe(cfg) {
  return {
    env: cfg.nodeEnv,
    port: cfg.port,
    host: cfg.host,
    cors: cfg.corsOrigins === null ? 'permissive' : cfg.corsOrigins.length ? cfg.corsOrigins : 'same-origin',
    rateLimit: cfg.rateLimit,
    adminApiKey: cfg.adminApiKey ? 'set' : 'not set',
    logLevel: cfg.logLevel,
    trustProxy: cfg.trustProxy,
  };
}

const config = build(process.env);
Object.defineProperty(config, 'loadConfig', { value: loadConfig, enumerable: false });
Object.defineProperty(config, 'describe', { value: describe, enumerable: false });
Object.defineProperty(config, 'ConfigError', { value: ConfigError, enumerable: false });
Object.freeze(config);

module.exports = config;
