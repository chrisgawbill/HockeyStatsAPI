const express = require('express');
const { aiRateLimiter } = require('#presentation/middleware/rateLimiter.js');

/**
 * POST /python-service
 * Rate-limited AI team-history endpoint. The handler validates the cache key
 * shape and shells out to the AI slice service for everything else.
 */
function createAiRouter({ aiSummaryService }) {
  const router = express.Router();

  router.post('/', aiRateLimiter, async (req, res, next) => {
    try {
      const key = req.body.cacheKey ?? 'default';
      if (key !== 'default' && !/^[A-Z]{3}$/.test(key)) {
        return res.status(400).json({ error: 'Invalid cacheKey format.' });
      }

      const summary = await aiSummaryService.getTeamHistorySummary({
        cacheKey: key,
        message: req.body.content,
        triCode: req.body.triCode,
      });
      res.send(summary);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createAiRouter };
