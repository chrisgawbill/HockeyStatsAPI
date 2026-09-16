const jwt = require('jsonwebtoken');

const SESSION_JWT_EXPIRY = '30d';

function getSecret() {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) {
    throw new Error('SESSION_JWT_SECRET is required to issue or verify session tokens.');
  }
  return secret;
}

/**
 * Issues an app-owned session token for `userId`. This is never the Google
 * ID token — callers get a short-lived (30-day), app-signed credential instead.
 * @param {{ userId: number|string }} claims
 * @returns {string}
 */
function signSessionToken({ userId }) {
  return jwt.sign({ userId }, getSecret(), { expiresIn: SESSION_JWT_EXPIRY });
}

/**
 * Verifies and decodes a session token. Throws (jsonwebtoken's own errors,
 * e.g. TokenExpiredError/JsonWebTokenError) if the token is invalid or expired.
 * @param {string} token
 * @returns {{ userId: number|string, iat: number, exp: number }}
 */
function verifySessionToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signSessionToken, verifySessionToken };
