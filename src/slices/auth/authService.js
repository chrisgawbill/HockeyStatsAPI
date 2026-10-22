const createError = require('http-errors');
const userRepository = require('#slices/auth/userRepository.js');

// RFC 7636 code_verifier: 43-128 characters from the unreserved set.
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Auth slice service: verifies Google Identity Services credentials and
 * Discord OAuth2 authorization codes (with PKCE), maps each provider identity
 * to one account in `user_identities`, and issues/validates the app's own
 * session JWT. A new identity links to an existing account only through a
 * verified email. Never persists or returns a provider's token itself.
 *
 * @param {{
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 *   googleAuth: { verifyGoogleIdToken: (idToken: string) => Promise<any> },
 *   discordAuth: {
 *     getAllowedRedirectUris: () => string[],
 *     verifyDiscordCode: (params: {
 *       code: string, codeVerifier: string, redirectUri: string,
 *     }) => Promise<{ id: string, email: string|null, verified: boolean }>,
 *   },
 *   emailCrypto: {
 *     encryptEmail: (email: string) => string,
 *     hashEmailForLookup: (email: string) => string,
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

  /**
   * Resolves an identity to its account in one transaction: a known identity
   * signs in as its user (adopting a changed verified email unless another
   * user holds it); an unknown one links to the user holding the same
   * verified email, or else gets a new user. An unverified email never sets
   * or changes a lookup.
   */
  async function resolveUser(client, { provider, subject, email, emailLookup }) {
    const existingUser = await userRepository.findUserByIdentity(client, {
      provider,
      subject,
    });
    if (existingUser) {
      await userRepository.touchIdentity(client, { provider, subject });
      if (emailLookup && existingUser.email_lookup !== emailLookup) {
        const holder = await userRepository.findUserByEmailLookup(
          client,
          emailLookup,
        );
        if (!holder) {
          return await userRepository.updateUserEmail(client, {
            userId: existingUser.id,
            emailEncrypted: emailCrypto.encryptEmail(email),
            emailLookup,
          });
        }
      }
      return existingUser;
    }

    const linkedUser = emailLookup
      ? await userRepository.findUserByEmailLookup(client, emailLookup)
      : null;
    const user =
      linkedUser ??
      (await userRepository.createUser(client, {
        emailEncrypted: email ? emailCrypto.encryptEmail(email) : null,
        emailLookup,
      }));
    await userRepository.addIdentity(client, {
      userId: user.id,
      provider,
      subject,
    });
    return user;
  }

  /**
   * Shared sign-in for every provider. A unique-index race with a concurrent
   * sign-in (23505) is retried once in a fresh transaction, which then sees
   * the other sign-in's rows.
   * @param {{ provider: 'google'|'discord', subject: string,
   *   email: string|null, emailVerified: boolean }} identity
   * @returns {Promise<{ token: string, email: string|null }>}
   */
  async function signIn({ provider, subject, email, emailVerified }) {
    const params = {
      provider,
      subject,
      email: email || null,
      emailLookup:
        emailVerified && email ? emailCrypto.hashEmailForLookup(email) : null,
    };
    let user;
    try {
      user = await withTransaction((client) => resolveUser(client, params));
    } catch (error) {
      if (error.code !== '23505') {
        throw error;
      }
      try {
        user = await withTransaction((client) => resolveUser(client, params));
      } catch (retryError) {
        if (retryError.code === '23505') {
          throw createError(409, 'Sign-in conflict. Please try again.');
        }
        throw retryError;
      }
    }

    const token = sessionJwt.signSessionToken({ userId: user.id });
    return { token, email: readEmail(user) };
  }

  return {
    /**
     * Verifies a Google ID token, signs in (or links/creates) the account, and
     * returns an app session token plus the user's email.
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
      } catch {
        throw createError(401, 'Invalid Google credential.');
      }

      if (!payload || !payload.sub) {
        throw createError(401, 'Invalid Google credential.');
      }

      return await signIn({
        provider: 'google',
        subject: payload.sub,
        email: payload.email ?? null,
        emailVerified: payload.email_verified === true,
      });
    },

    /**
     * Exchanges a Discord authorization code with its PKCE code verifier,
     * signs in (or links/creates) the account, and returns an app session
     * token plus the user's email. `redirectUri` must be one of
     * DISCORD_REDIRECT_URIS. The email is kept only when Discord has verified it.
     * @param {{ code: string, codeVerifier: string, redirectUri: string }} params
     * @returns {Promise<{ token: string, email: string|null }>}
     */
    async signInWithDiscord({ code, codeVerifier, redirectUri } = {}) {
      if (!code || typeof code !== 'string') {
        throw createError(400, 'code is required.');
      }
      if (
        typeof codeVerifier !== 'string' ||
        !CODE_VERIFIER_PATTERN.test(codeVerifier)
      ) {
        throw createError(400, 'codeVerifier is required.');
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
        discordUser = await discordAuth.verifyDiscordCode({
          code,
          codeVerifier,
          redirectUri,
        });
      } catch (error) {
        if (error.response?.status) {
          console.error(`Discord sign-in failed: ${error.response.status}`);
        }
        throw createError(401, 'Invalid Discord authorization.');
      }

      if (!discordUser || !discordUser.id) {
        throw createError(401, 'Invalid Discord authorization.');
      }

      const emailVerified = discordUser.verified === true;
      return await signIn({
        provider: 'discord',
        subject: discordUser.id,
        email: emailVerified ? discordUser.email : null,
        emailVerified,
      });
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
