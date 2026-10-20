const createError = require('http-errors');

/** Terminal 404: nothing matched, so hand a 404 to the error handler. */
function notFoundHandler(req, res, next) {
  next(createError(404));
}

/** Single JSON error shape for every failed request. */
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  console.error(`${req.method} ${req.originalUrl} failed:`, error);
  res
    .status(error.status || 500)
    .json({ error: error.message ?? 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };
