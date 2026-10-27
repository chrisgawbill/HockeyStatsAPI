const express = require('express');
const createError = require('http-errors');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');
const {
  pollRateLimiter: defaultPollRateLimiter,
} = require('#presentation/middleware/rateLimiter.js');
const { assertBearerSecret } = require('#platform/bearerSecret.js');

/** NHL game ids are ten digits: season start year, game type, game number. */
const GAME_ID_PATTERN = /^\d{10}$/;

/**
 * Schedule endpoints:
 *   GET /schedule/?season=          season schedule as `{ games }`
 *   GET /schedule/landing/:gameID   raw gamecenter landing payload
 *   GET /schedule/playbyplay/:gameID  shots and goals as a PlayByPlayContract
 *   GET /schedule/:gameID           raw gamecenter boxscore payload
 *   POST /schedule/poll             Bearer CRON_SECRET; league-wide live poll
 *                                   -> { polled, live, final, failed }
 */
function createScheduleRouter({
  scheduleService,
  pollRateLimiter = defaultPollRateLimiter,
}) {
  const router = express.Router();

  router.post('/poll', pollRateLimiter, async (req, res, next) => {
    try {
      assertBearerSecret(req.get('authorization'), process.env.CRON_SECRET);
      res.send(await scheduleService.pollGames());
    } catch (error) {
      next(error);
    }
  });

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

  router.get('/playbyplay/:gameID', async (req, res, next) => {
    if (!GAME_ID_PATTERN.test(req.params.gameID)) {
      return next(createError(404, 'Unknown game.'));
    }
    try {
      res.send(await scheduleService.getGamePlayByPlay(req.params.gameID));
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
