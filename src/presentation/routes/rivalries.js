const express = require('express');

/**
 * Site-wide team rivalries:
 *   GET /rivalries           -> { rivalries: [{ teams: [triCode, triCode], tier, displayName }] }
 *   GET /rivalries/:triCode  -> same shape, only that team's rivalries
 */
function createRivalriesRouter({ rivalryService }) {
  const router = express.Router();

  router.get('/:triCode?', async (req, res, next) => {
    try {
      res.send(await rivalryService.listRivalries(req.params.triCode));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRivalriesRouter };
