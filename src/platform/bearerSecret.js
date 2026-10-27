const crypto = require('crypto');
const createError = require('http-errors');

/** Length-safe constant-time string comparison. */
function secretsMatch(candidate, expected) {
  const candidateDigest = crypto
    .createHash('sha256')
    .update(String(candidate))
    .digest();
  const expectedDigest = crypto
    .createHash('sha256')
    .update(String(expected))
    .digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

/** Throws 503 when `secret` is unset, 401 unless the header is `Bearer <secret>`. */
function assertBearerSecret(authorizationHeader, secret) {
  if (!secret) throw createError(503, 'Not configured.');
  const [scheme, token] = String(authorizationHeader || '').split(' ');
  if (scheme !== 'Bearer' || !token || !secretsMatch(token, secret)) {
    throw createError(401, 'Unauthorized');
  }
}

module.exports = { assertBearerSecret };
