const express = require('express');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');

/**
 * GET /standings/?season=
 * Reads the validated season from `req.seasonId` and returns whatever the
 * standings service produces. No fetching, caching, or mapping lives here.
 */
function createStandingsRouter({ standingsService }) {
  const router = express.Router();

  router.get('/', validateSeason, async (req, res, next) => {
    try {
      res.send(await standingsService.getStandings(req.seasonId));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createStandingsRouter };
