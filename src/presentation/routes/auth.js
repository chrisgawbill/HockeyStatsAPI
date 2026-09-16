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
      const result = await authService.signInWithGoogle(credential);
      res.send(result);
    } catch (e) {
      next(e);
    }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const header = req.get('authorization') || '';
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) {
        throw createError(401, 'Unauthorized');
      }
      res.send(await authService.getSessionUser(token));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
