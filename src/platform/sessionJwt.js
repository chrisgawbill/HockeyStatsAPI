const jwt = require('jsonwebtoken');

const SESSION_JWT_EXPIRY = '30d';
const READ_TOKEN_PURPOSE = 'aar-read';
const WEEKLY_READ_TOKEN_PURPOSE = 'wpr-read';
const WEEK_START_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the JWT signing secret, failing loudly when it is not configured. */
function getSecret() {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_JWT_SECRET is required to issue or verify session tokens.',
    );
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
 * Tokens without a `userId` claim or carrying a `purpose` (e.g. push read
 * tokens, which share the signing secret) are rejected.
 * @param {string} token
 * @returns {{ userId: number|string, iat: number, exp: number }}
 */
function verifySessionToken(token) {
  const decoded = jwt.verify(token, getSecret());
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    decoded.purpose !== undefined ||
    decoded.userId === undefined ||
    decoded.userId === null
  ) {
    throw new jwt.JsonWebTokenError('not a session token');
  }
  return decoded;
}

/**
 * Issues a single-purpose token that lets a push notification tap mark one
 * After Action Report read without a session.
 * @param {{ userId: number|string, gameId: number }} claims
 * @returns {string}
 */
function signReadToken({ userId, gameId }) {
  return jwt.sign(
    { purpose: READ_TOKEN_PURPOSE, sub: String(userId), gameId },
    getSecret(),
    { expiresIn: SESSION_JWT_EXPIRY },
  );
}

/**
 * Verifies a read token; rejects session tokens and anything else.
 * @param {string} token
 * @returns {{ userId: string, gameId: number }}
 */
function verifyReadToken(token) {
  const decoded = jwt.verify(token, getSecret());
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    decoded.purpose !== READ_TOKEN_PURPOSE ||
    typeof decoded.sub !== 'string' ||
    !decoded.sub ||
    !Number.isSafeInteger(decoded.gameId) ||
    decoded.gameId <= 0
  ) {
    throw new jwt.JsonWebTokenError('not a read token');
  }
  return { userId: decoded.sub, gameId: decoded.gameId };
}

/**
 * Issues a single-purpose token that lets a weekly-report push tap mark that
 * week's Weekly Player Report read without a session.
 * @param {{ userId: number|string, weekStart: string }} claims
 * @returns {string}
 */
function signWeeklyReadToken({ userId, weekStart }) {
  return jwt.sign(
    { purpose: WEEKLY_READ_TOKEN_PURPOSE, sub: String(userId), weekStart },
    getSecret(),
    { expiresIn: SESSION_JWT_EXPIRY },
  );
}

/**
 * Verifies a weekly-report read token; rejects every other token.
 * @param {string} token
 * @returns {{ userId: string, weekStart: string }}
 */
function verifyWeeklyReadToken(token) {
  const decoded = jwt.verify(token, getSecret());
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    decoded.purpose !== WEEKLY_READ_TOKEN_PURPOSE ||
    typeof decoded.sub !== 'string' ||
    !decoded.sub ||
    typeof decoded.weekStart !== 'string' ||
    !WEEK_START_PATTERN.test(decoded.weekStart)
  ) {
    throw new jwt.JsonWebTokenError('not a weekly read token');
  }
  return { userId: decoded.sub, weekStart: decoded.weekStart };
}

module.exports = {
  signSessionToken,
  verifySessionToken,
  signReadToken,
  verifyReadToken,
  signWeeklyReadToken,
  verifyWeeklyReadToken,
};
