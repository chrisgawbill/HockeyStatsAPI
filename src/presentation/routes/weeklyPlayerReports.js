const express = require('express');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');
const { validateLeague } = require('#presentation/middleware/validateLeague.js');

/**
 * Favorite players of both leagues, behind requireAuth. The routes with a
 * player id take `?league=nhl|ahl` (default nhl):
 *   GET    /api/favorite-players            -> { favorites: [{ league, playerId, name, teamTriCode, position, headshot, since, tier, label, pushMuted }] }
 *   PATCH  /api/favorite-players/:playerId  body { tier?, label? } -> { favorites }
 *   PUT    /api/favorite-players/:playerId  -> { favorites } (409 past the cap)
 *   PUT    /api/favorite-players/:playerId/push-mute  body { muted } -> { favorites }
 *   DELETE /api/favorite-players/:playerId  -> { favorites }
 */
function createFavoritePlayersRouter({ weeklyPlayerReportService }) {
  const router = express.Router();
  router.use(requireAuth, validateLeague);

  router.get('/', async (req, res, next) => {
    try {
      res.send({
        favorites: await weeklyPlayerReportService.listFavorites(req.userId),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/:playerId', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.addFavorite(
          req.userId,
          req.params.playerId,
          req.league,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:playerId', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.updateCategory(
          req.userId,
          req.params.playerId,
          req.body,
          req.league,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.put('/:playerId/push-mute', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.setPushMuted(
          req.userId,
          req.params.playerId,
          (req.body || {}).muted,
          req.league,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:playerId', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.removeFavorite(
          req.userId,
          req.params.playerId,
          req.league,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Weekly Player Reports, behind requireAuth:
 *   GET  /api/weekly-player-reports                  -> { reports, unreadCount }
 *   GET  /api/weekly-player-reports/:weekStart       -> report (404 when none)
 *   POST /api/weekly-player-reports/:weekStart/read  -> 204
 */
function createWeeklyPlayerReportsRouter({ weeklyPlayerReportService }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      res.send(await weeklyPlayerReportService.listReports(req.userId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:weekStart', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.getReport(
          req.userId,
          req.params.weekStart,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/:weekStart/read', async (req, res, next) => {
    try {
      await weeklyPlayerReportService.markRead(
        req.userId,
        req.params.weekStart,
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createFavoritePlayersRouter,
  createWeeklyPlayerReportsRouter,
};
