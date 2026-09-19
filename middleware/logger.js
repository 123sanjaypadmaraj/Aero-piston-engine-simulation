/**
 * middleware/logger.js
 * -----------------------------------------------------------------------
 * Minimal dependency-free structured logger + request-ID / access-log
 * middleware. JSON lines in production (easy to ship to a log collector),
 * human-readable lines in development. Honors LOG_LEVEL.
 * -----------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function createLogger({ level = 'info', json = false, base = {}, stream } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] > threshold) return;
    const out = stream || (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout);
    const extra = { ...base, ...fields };
    if (extra.err) extra.err = serializeError(extra.err);
    let line;
    if (json) {
      line = JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...extra });
    } else {
      const { err, ...rest } = extra;
      const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      line = `${new Date().toISOString().slice(11, 23)} ${lvl.toUpperCase().padEnd(5)} ${msg}${tail}`;
      if (err) line += `\n${err.stack || err.message || err}`;
    }
    out.write(`${line}\n`);
  }

  const logger = {
    level,
    error: (msg, fields) => write('error', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
    child: (fields) => createLogger({ level, json, stream, base: { ...base, ...fields } }),
  };
  return logger;
}

/** Assigns req.id (echoing a sane inbound X-Request-Id) and logs each finished request. */
function requestLogger(logger) {
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    req.id = typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    req.log = logger.child({ reqId: req.id });
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const isApi = req.originalUrl.startsWith('/api/');
      const noisy = req.originalUrl === '/api/health' || req.originalUrl === '/api/ready';
      const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : isApi && !noisy ? 'info' : 'debug';
      logger[lvl]('request', {
        reqId: req.id,
        method: req.method,
        url: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.ip,
      });
    });
    next();
  };
}

module.exports = { createLogger, requestLogger, LEVELS };
