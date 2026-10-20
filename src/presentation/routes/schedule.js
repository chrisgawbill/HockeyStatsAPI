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
    } catch (error) {
      next(error);
    }
  });

  router.get('/landing/:gameID', async (req, res, next) => {
    try {
      res.send(await scheduleService.getGameLanding(req.params.gameID));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:gameID', async (req, res, next) => {
    try {
      res.send(await scheduleService.getGameBoxscore(req.params.gameID));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createScheduleRouter };
