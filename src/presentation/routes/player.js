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
 *   GET /player/skater/faceoffs?teamId=
 *   GET /player/goalie/summary?teamId=
 *   GET /player/stats/version   -> { version }, changes when stored stats do
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
    } catch (error) {
      next(error);
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
    } catch (error) {
      next(error);
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
    } catch (error) {
      next(error);
    }
  });

  router.get('/skater/corsi', async (req, res, next) => {
    try {
      res.send(
        await playerStatsService.getSkaterCorsi(req.query.teamId, req.seasonId),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/skater/faceoffs', async (req, res, next) => {
    try {
      res.send(
        await playerStatsService.getSkaterFaceoffs(
          req.query.teamId,
          req.seasonId,
        ),
      );
    } catch (error) {
      next(error);
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
    } catch (error) {
      next(error);
    }
  });

  router.get('/stats/version', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.send(await playerStatsService.getStatsVersion());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createPlayerRouter };
