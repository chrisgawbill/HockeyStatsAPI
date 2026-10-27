const express = require('express');

/**
 * Rink Quest team and player profiles:
 *   GET /rink-quest/teams
 *     -> { teams: [{ teamId, triCode, name, logoUrl, primaryIdentity, secondaryIdentity }] }
 *   GET /rink-quest/teams/:triCode/candidates
 *     -> { team, candidates: [{ playerId, name, positionCode, sweaterNumber,
 *          headshotUrl, archetype, appearanceRank }] }
 */
function createRinkQuestRouter({ rinkQuestProfileService }) {
  const router = express.Router();

  router.get('/teams', async (req, res, next) => {
    try {
      res.send(await rinkQuestProfileService.listTeams());
    } catch (error) {
      next(error);
    }
  });

  router.get('/teams/:triCode/candidates', async (req, res, next) => {
    try {
      res.send(await rinkQuestProfileService.listCandidates(req.params.triCode));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRinkQuestRouter };
