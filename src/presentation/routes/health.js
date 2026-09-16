const express = require('express');
const { authCheck } = require('#presentation/middleware/auth.js');
const { getCurrentSeasonId } = require('#platform/seasonHelper.js');
const { version } = require('../../../package.json');

/**
 * Diagnostics endpoints (intentionally unlinked from the UI), gated by the
 * shared passphrase header:
 *   GET /health              service/cache status snapshot
 *   GET /health/cache-usage  per-section cache usage report
 */
function createHealthRouter({ cache }) {
  const router = express.Router();
  router.use(authCheck);

  router.get('/', async (req, res, next) => {
    try {
      res.json({
        status: 'ok',
        version,
        environment: process.env.NODE_ENV || 'development',
        currentSeason: getCurrentSeasonId(),
        cacheStorageMode: cache.getCacheStorageMode(),
        cacheWritable: await cache.isCacheWritable(),
        externalCacheConfigured: await cache.isExternalCacheConfigured(),
        externalCacheReachable: await cache.isExternalCacheReachable(),
        anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        uptime: process.uptime(),
        currentTime: new Date().toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/cache-usage', async (req, res, next) => {
    try {
      res.json(await cache.getCacheUsage());
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createHealthRouter };
