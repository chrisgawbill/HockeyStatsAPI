const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');

/**
 * Team endpoints, all season-capable:
 *   GET /team/roster/:triCode?season=    normalized RosterContract
 *   GET /team/lines/:triCode?season=     forward lines / D pairs / starter from the latest shift chart
 *   GET /team/schedule/:triCode?season=  `{ games }` sorted by date
 *   GET /team/:teamId??season=           raw team summary stats
 *
 * The schedule endpoint is served by the schedule slice (it owns schedule
 * mapping and persistence); this router just composes the two services.
 */
function createTeamRouter({
  teamService,
  rosterService,
  scheduleService,
  lineService,
}) {
  const router = express.Router();
  router.use(validateSeason);

  router.get('/roster/:triCode', async (req, res, next) => {
    try {
      res.send(await rosterService.getRoster(req.params.triCode, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/lines/:triCode', async (req, res, next) => {
    try {
      res.send(await lineService.getLines(req.params.triCode, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/schedule/:triCode', async (req, res, next) => {
    try {
      res.send(
        await scheduleService.getTeamSchedule(req.params.triCode, req.seasonId),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:teamId?', async (req, res, next) => {
    try {
      res.send(
        await teamService.getTeamSummary(req.params.teamId, req.seasonId),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createTeamRouter };
