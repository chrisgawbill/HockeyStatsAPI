const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');
const {
  validateLeague,
  nhlOnly,
} = require('#presentation/middleware/validateLeague.js');

/**
 * Team endpoints, all season-capable; all but lines also serve `league=ahl`
 * (AHL tri-codes and HockeyTech team ids):
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
  ahlReadService,
}) {
  const router = express.Router();
  router.use(validateSeason, validateLeague);

  router.get('/roster/:triCode', async (req, res, next) => {
    try {
      const service = req.league === 'ahl' ? ahlReadService : rosterService;
      res.send(await service.getRoster(req.params.triCode, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/lines/:triCode', nhlOnly, async (req, res, next) => {
    try {
      res.send(await lineService.getLines(req.params.triCode, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/schedule/:triCode', async (req, res, next) => {
    try {
      const service = req.league === 'ahl' ? ahlReadService : scheduleService;
      res.send(await service.getTeamSchedule(req.params.triCode, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:teamId?', async (req, res, next) => {
    try {
      const service = req.league === 'ahl' ? ahlReadService : teamService;
      res.send(await service.getTeamSummary(req.params.teamId, req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createTeamRouter };
