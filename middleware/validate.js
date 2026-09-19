/**
 * middleware/validate.js
 * -----------------------------------------------------------------------
 * Small hand-rolled validators for route params/bodies. Engine and mission
 * ids are used to build file paths in twin_core/store, so SAFE_ID is
 * deliberately restrictive (no dots, slashes, or backslashes) which makes
 * path traversal impossible; Windows reserved device names are refused too.
 * -----------------------------------------------------------------------
 */

'use strict';

const { HttpError } = require('./errors');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function isSafeId(v) {
  return typeof v === 'string' && SAFE_ID.test(v) && !WINDOWS_RESERVED.test(v);
}

function safeId(value, name) {
  if (!isSafeId(value)) {
    throw new HttpError(400, `invalid ${name}`, `${name} must match ${SAFE_ID} (letters, digits, "_" and "-", max 64 chars)`);
  }
  return value;
}

function numberInRange(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `invalid ${name}`, `${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/** Body must be a JSON object (or absent). Returns {} for a missing body. */
function bodyObject(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'request body must be a JSON object');
  return b;
}

module.exports = { SAFE_ID, isSafeId, safeId, numberInRange, bodyObject };
