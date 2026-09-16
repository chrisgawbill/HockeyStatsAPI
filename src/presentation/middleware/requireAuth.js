const createError = require('http-errors');
const { verifySessionToken } = require('#platform/sessionJwt.js');

/**
 * Verifies the `Authorization: Bearer <token>` header against the app's own
 * session JWT (see `#platform/sessionJwt.js`) and attaches `req.userId`.
 * Unrelated to `middleware/auth.js`, which gates the diagnostics routes with
 * a static passphrase.
 */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(createError(401, 'Unauthorized'));
  }

  try {
    const decoded = verifySessionToken(token);
    req.userId = decoded.userId;
    next();
  } catch {
    next(createError(401, 'Unauthorized'));
  }
}

module.exports = { requireAuth };
