const express = require('express');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');

/**
 * Favorite players, behind requireAuth:
 *   GET    /api/favorite-players            -> { favorites: [{ playerId, name, teamTriCode, position, headshot, since }] }
 *   PUT    /api/favorite-players/:playerId  -> { favorites } (409 past the cap)
 *   DELETE /api/favorite-players/:playerId  -> { favorites }
 */
function createFavoritePlayersRouter({ weeklyPlayerReportService }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      res.send({
        favorites: await weeklyPlayerReportService.listFavorites(req.userId),
      });
    } catch (e) {
      next(e);
    }
  });

  router.put('/:playerId', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.addFavorite(
          req.userId,
          req.params.playerId,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:playerId', async (req, res, next) => {
    try {
      res.send(
        await weeklyPlayerReportService.removeFavorite(
          req.userId,
          req.params.playerId,
        ),
      );
    } catch (e) {
      next(e);
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
    } catch (e) {
      next(e);
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
    } catch (e) {
      next(e);
    }
  });

  router.post('/:weekStart/read', async (req, res, next) => {
    try {
      await weeklyPlayerReportService.markRead(
        req.userId,
        req.params.weekStart,
      );
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  createFavoritePlayersRouter,
  createWeeklyPlayerReportsRouter,
};
