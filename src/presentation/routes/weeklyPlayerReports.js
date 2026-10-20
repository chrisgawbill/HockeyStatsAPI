const express = require('express');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');

/**
 * Favorite players, behind requireAuth:
 *   GET    /api/favorite-players            -> { favorites: [{ playerId, name, teamTriCode, position, headshot, since, tier, label }] }
 *   PATCH  /api/favorite-players/:playerId  body { tier?, label? } -> { favorites }
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
