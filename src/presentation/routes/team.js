const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');

/**
 * Team endpoints, all season-capable:
 *   GET /team/roster/:triCode?season=    normalized RosterContract
 *   GET /team/schedule/:triCode?season=  `{ games }` sorted by date
 *   GET /team/:teamId??season=           raw team summary stats
 *
 * The schedule endpoint is served by the schedule slice (it owns schedule
 * mapping and persistence); this router just composes the two services.
 */
function createTeamRouter({ teamService, rosterService, scheduleService }) {
  const router = express.Router();
  router.use(validateSeason);

  router.get('/roster/:triCode', async (req, res, next) => {
    try {
      res.send(await rosterService.getRoster(req.params.triCode, req.seasonId));
    } catch (e) {
      next(e);
    }
  });

  router.get('/schedule/:triCode', async (req, res, next) => {
    try {
      res.send(
        await scheduleService.getTeamSchedule(req.params.triCode, req.seasonId),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/:teamId?', async (req, res, next) => {
    try {
      res.send(
        await teamService.getTeamSummary(req.params.teamId, req.seasonId),
      );
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createTeamRouter };
