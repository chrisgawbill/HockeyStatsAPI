const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');
const {
  validateLeague,
} = require('#presentation/middleware/validateLeague.js');

/**
 * GET /standings/?season=&league=
 * Reads the validated season from `req.seasonId` and returns whatever the
 * standings service (or the AHL read service for `league=ahl`) produces. No
 * fetching, caching, or mapping lives here.
 */
function createStandingsRouter({ standingsService, ahlReadService }) {
  const router = express.Router();

  router.get('/', validateSeason, validateLeague, async (req, res, next) => {
    try {
      const service = req.league === 'ahl' ? ahlReadService : standingsService;
      res.send(await service.getStandings(req.seasonId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createStandingsRouter };
