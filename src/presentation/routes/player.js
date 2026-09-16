const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');

/**
 * Player endpoints, all season-capable:
 *   GET /player/skater/statLeaders/:statIndicator
 *   GET /player/goalie/statLeaders/:statIndicator
 *   GET /player/skater/summary?teamId=
 *   GET /player/skater/corsi?teamId=
 *   GET /player/goalie/summary?teamId=
 */
function createPlayerRouter({ playerStatsService, statLeaderService }) {
  const router = express.Router();
  router.use(validateSeason);

  router.get('/skater/statLeaders/:statIndicator', async (req, res, next) => {
    try {
      res.send(
        await statLeaderService.getSkaterLeaders(
          req.params.statIndicator,
          req.seasonId,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/goalie/statLeaders/:statIndicator', async (req, res, next) => {
    try {
      res.send(
        await statLeaderService.getGoalieLeaders(
          req.params.statIndicator,
          req.seasonId,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/skater/summary', async (req, res, next) => {
    try {
      res.send(
        await playerStatsService.getSkaterSummary(
          req.query.teamId,
          req.seasonId,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/skater/corsi', async (req, res, next) => {
    try {
      res.send(
        await playerStatsService.getSkaterCorsi(req.query.teamId, req.seasonId),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/goalie/summary', async (req, res, next) => {
    try {
      res.send(
        await playerStatsService.getGoalieSummary(
          req.query.teamId,
          req.seasonId,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createPlayerRouter };
