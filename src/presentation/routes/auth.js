const express = require('express');
const createError = require('http-errors');

/**
 * Auth endpoints:
 *   POST /api/auth/google   body { credential }  -> { token, email }
 *   POST /api/auth/discord  body { code, codeVerifier, redirectUri }  -> { token, email }
 *     (OAuth2 authorization code + PKCE: codeVerifier is the RFC 7636 verifier
 *     whose S256 challenge the frontend sent to Discord)
 * Sign-in failures are 401 with a fixed message; 400 for a missing or invalid
 * field. A Google and a Discord identity share one account when both carry the
 * same verified email.
 *   GET  /api/auth/me       Authorization: Bearer <token>  -> { email }
 */
function createAuthRouter({ authService }) {
  const router = express.Router();

  router.post('/google', async (req, res, next) => {
    try {
      const { credential } = req.body || {};
      const signedInUser = await authService.signInWithGoogle(credential);
      res.send(signedInUser);
    } catch (error) {
      next(error);
    }
  });

  router.post('/discord', async (req, res, next) => {
    try {
      const { code, codeVerifier, redirectUri } = req.body || {};
      const signedInUser = await authService.signInWithDiscord({
        code,
        codeVerifier,
        redirectUri,
      });
      res.send(signedInUser);
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const authorizationHeader = req.get('authorization') || '';
      const [scheme, token] = authorizationHeader.split(' ');
      if (scheme !== 'Bearer' || !token) {
        throw createError(401, 'Unauthorized');
      }
      res.send(await authService.getSessionUser(token));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
