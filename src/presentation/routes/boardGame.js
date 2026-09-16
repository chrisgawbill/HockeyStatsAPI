const express = require('express');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');

/**
 * Board game streak sync endpoints, both behind requireAuth:
 *   GET /api/board-game/streak            -> StreakData for req.userId
 *   PUT /api/board-game/streak  body StreakData -> merged StreakData
 */
function createBoardGameRouter({ boardGameStreakService }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/streak', async (req, res, next) => {
    try {
      res.send(await boardGameStreakService.getStreakForUser(req.userId));
    } catch (e) {
      next(e);
    }
  });

  router.put('/streak', async (req, res, next) => {
    try {
      res.send(
        await boardGameStreakService.putStreakForUser(req.userId, req.body),
      );
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createBoardGameRouter };
