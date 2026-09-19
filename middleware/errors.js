/**
 * middleware/errors.js
 * -----------------------------------------------------------------------
 * Consistent JSON error responses: { error, detail? }. Stack traces and
 * internal messages are never sent to the client in production.
 * -----------------------------------------------------------------------
 */

'use strict';

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
    this.expose = true;
  }
}

/** Wraps an async route handler so a rejection reaches the error handler. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function notFound(_req, res) {
  res.status(404).json({ error: 'not found' });
}

function errorHandler(logger, { isProduction }) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = err.status || err.statusCode || 500;
    let message;
    let detail;

    if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'malformed JSON body';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      message = 'request body too large';
    } else if (err instanceof HttpError) {
      message = err.message;
      detail = err.detail;
    } else if (status >= 400 && status < 500) {
      message = err.expose ? err.message : 'bad request';
    } else {
      status = 500;
      message = 'internal server error';
      // Detail is only surfaced outside production, to ease local debugging.
      if (!isProduction) detail = err.message;
    }

    if (status >= 500) (req.log || logger).error('unhandled route error', { reqId: req.id, err });
    res.status(status).json(detail === undefined ? { error: message } : { error: message, detail });
  };
}

module.exports = { HttpError, asyncHandler, notFound, errorHandler };
