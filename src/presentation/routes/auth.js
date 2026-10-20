const express = require('express');
const createError = require('http-errors');

/**
 * Auth endpoints:
 *   POST /api/auth/google  body { credential }  -> { token, email }
 *   GET  /api/auth/me      Authorization: Bearer <token>  -> { email }
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
