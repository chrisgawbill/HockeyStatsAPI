const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');

/**
 * Schedule endpoints:
 *   GET /schedule/?season=          season schedule as `{ games }`
 *   GET /schedule/landing/:gameID   raw gamecenter landing payload
 *   GET /schedule/:gameID           raw gamecenter boxscore payload
 */
function createScheduleRouter({ scheduleService }) {
  const router = express.Router();

  router.get('/', validateSeason, async (req, res, next) => {
    try {
      res.send(await scheduleService.getSeasonSchedule(req.seasonId));
    } catch (e) {
      next(e);
    }
  });

  router.get('/landing/:gameID', async (req, res, next) => {
    try {
      res.send(await scheduleService.getGameLanding(req.params.gameID));
    } catch (e) {
      next(e);
    }
  });

  router.get('/:gameID', async (req, res, next) => {
    try {
      res.send(await scheduleService.getGameBoxscore(req.params.gameID));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createScheduleRouter };
