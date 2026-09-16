const createError = require('http-errors');
const userRepository = require('#slices/auth/userRepository.js');

/**
 * Auth slice service: verifies Google Identity Services credentials and
 * issues/validates the app's own session JWT. Never persists or returns the
 * Google ID token itself.
 *
 * @param {{
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 *   googleAuth: { verifyGoogleIdToken: (idToken: string) => Promise<any> },
 *   sessionJwt: {
 *     signSessionToken: (claims: { userId: number|string }) => string,
 *     verifySessionToken: (token: string) => { userId: number|string },
 *   },
 * }} deps
 */
function createAuthService({ withTransaction, googleAuth, sessionJwt }) {
  return {
    /**
     * Verifies a Google ID token, upserts the user, and returns an app session
     * token plus the user's email.
     * @param {string} credential
     * @returns {Promise<{ token: string, email: string|null }>}
     */
    async signInWithGoogle(credential) {
      if (!credential || typeof credential !== 'string') {
        throw createError(400, 'credential is required.');
      }

      let payload;
      try {
        payload = await googleAuth.verifyGoogleIdToken(credential);
      } catch (err) {
        throw createError(401, `Invalid Google credential: ${err.message}`);
      }

      if (!payload || !payload.sub) {
        throw createError(401, 'Invalid Google credential.');
      }

      const user = await withTransaction((client) =>
        userRepository.upsertUserByGoogleSub(client, {
          googleSub: payload.sub,
          email: payload.email ?? null,
        }),
      );

      const token = sessionJwt.signSessionToken({ userId: user.id });
      return { token, email: user.email };
    },

    /**
     * Verifies a bearer session token and returns the associated user's email.
     * @param {string} token
     * @returns {Promise<{ email: string|null }>}
     */
    async getSessionUser(token) {
      const userId = requireValidUserId(sessionJwt, token);
      const user = await withTransaction((client) =>
        userRepository.getUserById(client, userId),
      );
      if (!user) {
        throw createError(401, 'Unauthorized');
      }
      return { email: user.email };
    },
  };
}

/** Shared bearer-token verification used by both the /me route and requireAuth. */
function requireValidUserId(sessionJwt, token) {
  if (!token) {
    throw createError(401, 'Unauthorized');
  }
  try {
    const decoded = sessionJwt.verifySessionToken(token);
    return decoded.userId;
  } catch {
    throw createError(401, 'Unauthorized');
  }
}

module.exports = { createAuthService, requireValidUserId };
