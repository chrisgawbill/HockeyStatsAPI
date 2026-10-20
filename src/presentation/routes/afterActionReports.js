const express = require('express');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');

/**
 * Favorite teams, behind requireAuth:
 *   GET    /api/favorites            -> { favorites: [{ triCode, since, pushMuted, tier, label }] }
 *   PATCH  /api/favorites/:triCode   body { tier?, label? } -> { favorites }
 *   PUT    /api/favorites/:triCode   -> { favorites }
 *   DELETE /api/favorites/:triCode   -> { favorites }
 *   PUT    /api/favorites/:triCode/push-mute  body { muted } -> { favorites }
 */
function createFavoritesRouter({ afterActionReportService }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      res.send({
        favorites: await afterActionReportService.listFavorites(req.userId),
      });
    } catch (e) {
      next(e);
    }
  });

  router.put('/:triCode', async (req, res, next) => {
    try {
      res.send(
        await afterActionReportService.addFavorite(
          req.userId,
          req.params.triCode,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.patch('/:triCode', async (req, res, next) => {
    try {
      res.send(
        await afterActionReportService.updateCategory(
          req.userId,
          req.params.triCode,
          req.body,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.put('/:triCode/push-mute', async (req, res, next) => {
    try {
      res.send(
        await afterActionReportService.setPushMuted(
          req.userId,
          req.params.triCode,
          (req.body || {}).muted,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:triCode', async (req, res, next) => {
    try {
      res.send(
        await afterActionReportService.removeFavorite(
          req.userId,
          req.params.triCode,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/**
 * After Action Report inbox, behind requireAuth:
 *   GET  /api/after-action-reports               -> { reports, unreadCount }
 *   POST /api/after-action-reports/read-all      -> { reports, unreadCount }
 *   POST /api/after-action-reports/:gameId/read  -> 204
 */
function createAfterActionReportsRouter({ afterActionReportService }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      res.send(await afterActionReportService.listReports(req.userId));
    } catch (e) {
      next(e);
    }
  });

  router.post('/read-all', async (req, res, next) => {
    try {
      res.send(await afterActionReportService.markAllRead(req.userId));
    } catch (e) {
      next(e);
    }
  });

  router.post('/:gameId/read', async (req, res, next) => {
    try {
      await afterActionReportService.markRead(req.userId, req.params.gameId);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createFavoritesRouter, createAfterActionReportsRouter };
