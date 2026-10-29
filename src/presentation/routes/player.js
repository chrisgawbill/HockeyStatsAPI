const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');
const {
  validateLeague,
  nhlOnly,
} = require('#presentation/middleware/validateLeague.js');

/**
 * Player endpoints, all season-capable:
 *   GET /player/skater/statLeaders/:statIndicator
 *   GET /player/goalie/statLeaders/:statIndicator
 *   GET /player/skater/summary?teamId=
 *   GET /player/skater/corsi?teamId=
 *   GET /player/skater/faceoffs?teamId=
 *   GET /player/goalie/summary?teamId=
 *   GET /player/stats/version   -> { version }, changes when stored stats do
 * All but corsi and faceoffs also serve `league=ahl` (HockeyTech team ids).
 */
function createPlayerRouter({
  playerStatsService,
  statLeaderService,
  ahlReadService,
}) {
  const router = express.Router();
  router.use(validateSeason, validateLeague);

  router.get('/skater/statLeaders/:statIndicator', async (req, res, next) => {
    try {
      res.send(
        req.league === 'ahl'
          ? await ahlReadService.getLeaders(
              'skater',
              req.params.statIndicator,
              req.seasonId,
            )
          : await statLeaderService.getSkaterLeaders(
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
        req.league === 'ahl'
          ? await ahlReadService.getLeaders(
              'goalie',
              req.params.statIndicator,
              req.seasonId,
            )
          : await statLeaderService.getGoalieLeaders(
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
      const service =
        req.league === 'ahl' ? ahlReadService : playerStatsService;
      res.send(await service.getSkaterSummary(req.query.teamId, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/skater/corsi', nhlOnly, async (req, res, next) => {
    try {
      res.send(
        await playerStatsService.getSkaterCorsi(req.query.teamId, req.seasonId),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/skater/faceoffs', nhlOnly, async (req, res, next) => {
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
      const service =
        req.league === 'ahl' ? ahlReadService : playerStatsService;
      res.send(await service.getGoalieSummary(req.query.teamId, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/stats/version', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const service =
        req.league === 'ahl' ? ahlReadService : playerStatsService;
      res.send(await service.getStatsVersion());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createPlayerRouter };
