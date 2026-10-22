const createError = require('http-errors');
const userRepository = require('#slices/auth/userRepository.js');

/**
 * Auth slice service: verifies Google Identity Services credentials and
 * Discord OAuth2 authorization codes, and issues/validates the app's own
 * session JWT. Never persists or returns a provider's token itself.
 *
 * @param {{
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 *   googleAuth: { verifyGoogleIdToken: (idToken: string) => Promise<any> },
 *   discordAuth: {
 *     getAllowedRedirectUris: () => string[],
 *     verifyDiscordCode: (params: { code: string, redirectUri: string }) =>
 *       Promise<{ id: string, email: string|null, verified: boolean }>,
 *   },
 *   emailCrypto: {
 *     protectEmail: (email: string|null) =>
 *       { emailEncrypted: string|null, emailLookup: string|null },
 *     decryptEmail: (encryptedEmail: string) => string,
 *   },
 *   sessionJwt: {
 *     signSessionToken: (claims: { userId: number|string }) => string,
 *     verifySessionToken: (token: string) => { userId: number|string },
 *   },
 * }} deps
 */
function createAuthService({
  withTransaction,
  googleAuth,
  discordAuth,
  emailCrypto,
  sessionJwt,
}) {
  /** Returns a user row's decrypted email, or null when none is stored. */
  function readEmail(user) {
    return user.email_encrypted
      ? emailCrypto.decryptEmail(user.email_encrypted)
      : null;
  }

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
      } catch (error) {
        throw createError(401, `Invalid Google credential: ${error.message}`);
      }

      if (!payload || !payload.sub) {
        throw createError(401, 'Invalid Google credential.');
      }

      const user = await withTransaction((client) =>
        userRepository.upsertUserByGoogleSub(client, {
          googleSub: payload.sub,
          ...emailCrypto.protectEmail(payload.email ?? null),
        }),
      );

      const token = sessionJwt.signSessionToken({ userId: user.id });
      return { token, email: readEmail(user) };
    },

    /**
     * Exchanges a Discord authorization code, upserts the user, and returns an
     * app session token plus the user's email. `redirectUri` must be one of
     * DISCORD_REDIRECT_URIS. The email is kept only when Discord has verified it.
     * @param {{ code: string, redirectUri: string }} params
     * @returns {Promise<{ token: string, email: string|null }>}
     */
    async signInWithDiscord({ code, redirectUri } = {}) {
      if (!code || typeof code !== 'string') {
        throw createError(400, 'code is required.');
      }
      if (
        !redirectUri ||
        typeof redirectUri !== 'string' ||
        !discordAuth.getAllowedRedirectUris().includes(redirectUri)
      ) {
        throw createError(400, 'redirectUri is not allowed.');
      }

      let discordUser;
      try {
        discordUser = await discordAuth.verifyDiscordCode({ code, redirectUri });
      } catch (error) {
        throw createError(401, `Invalid Discord code: ${error.message}`);
      }

      if (!discordUser || !discordUser.id) {
        throw createError(401, 'Invalid Discord code.');
      }

      const user = await withTransaction((client) =>
        userRepository.upsertUserByDiscordId(client, {
          discordId: discordUser.id,
          ...emailCrypto.protectEmail(
            discordUser.verified ? discordUser.email : null,
          ),
        }),
      );

      const token = sessionJwt.signSessionToken({ userId: user.id });
      return { token, email: readEmail(user) };
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
      return { email: readEmail(user) };
    },
  };
}

/** Shared bearer-token verification used by both the /me route and requireAuth. */
function requireValidUserId(sessionJwt, token) {
  if (!token) {
    throw createError(401, 'Unauthorized');
  }
  try {
    const { userId } = sessionJwt.verifySessionToken(token);
    return userId;
  } catch {
    throw createError(401, 'Unauthorized');
  }
}

module.exports = { createAuthService, requireValidUserId };
