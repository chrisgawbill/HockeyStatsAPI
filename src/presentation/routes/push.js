const express = require('express');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');
const {
  dispatchRateLimiter: defaultDispatchRateLimiter,
} = require('#presentation/middleware/rateLimiter.js');

/**
 * Web Push for After Action Reports:
 *   GET    /api/push/config         -> { enabled, publicKey }
 *   POST   /api/push/subscriptions  (session) PushSubscription JSON -> 204
 *   DELETE /api/push/subscriptions  (session) { endpoint } -> 204
 *   POST   /api/push/read           { token } -> 204 (read token, no session)
 *   POST   /api/push/dispatch       Bearer CRON_SECRET -> { users, sent, removed }
 *   GET    /api/push/weekly-report  (session) -> { enabled }
 *   PUT    /api/push/weekly-report  (session) { enabled } -> { enabled }
 *   POST   /api/push/weekly-dispatch Bearer CRON_SECRET, optional { weekStart }
 *          -> { weekStart, skipped?, created, users, sent, removed }
 */
function createPushRouter({
  pushNotificationService,
  dispatchRateLimiter = defaultDispatchRateLimiter,
}) {
  const router = express.Router();

  router.get('/config', (req, res, next) => {
    try {
      res.send(pushNotificationService.getConfig());
    } catch (e) {
      next(e);
    }
  });

  router.post('/subscriptions', requireAuth, async (req, res, next) => {
    try {
      await pushNotificationService.subscribe(req.userId, req.body);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.delete('/subscriptions', requireAuth, async (req, res, next) => {
    try {
      await pushNotificationService.unsubscribe(req.userId, req.body);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.post('/read', async (req, res, next) => {
    try {
      await pushNotificationService.markReadFromToken((req.body || {}).token);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.post('/dispatch', dispatchRateLimiter, async (req, res, next) => {
    try {
      pushNotificationService.assertDispatchAuthorized(
        req.get('authorization'),
      );
      res.send(await pushNotificationService.dispatch());
    } catch (e) {
      next(e);
    }
  });

  router.get('/weekly-report', requireAuth, async (req, res, next) => {
    try {
      res.send(await pushNotificationService.getWeeklyReportPush(req.userId));
    } catch (e) {
      next(e);
    }
  });

  router.put('/weekly-report', requireAuth, async (req, res, next) => {
    try {
      res.send(
        await pushNotificationService.setWeeklyReportPush(
          req.userId,
          (req.body || {}).enabled,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post(
    '/weekly-dispatch',
    dispatchRateLimiter,
    async (req, res, next) => {
      try {
        pushNotificationService.assertDispatchAuthorized(
          req.get('authorization'),
        );
        res.send(
          await pushNotificationService.weeklyDispatch({
            weekStart: (req.body || {}).weekStart,
          }),
        );
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}

module.exports = { createPushRouter };
