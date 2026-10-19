const crypto = require('crypto');
const createError = require('http-errors');
const repository = require('#slices/pushNotifications/pushNotificationRepository.js');

/** Dispatch skips games that started longer ago than this. */
const MAX_GAME_AGE_MS = 12 * 60 * 60 * 1000;
const PUSH_TTL_SECONDS = 6 * 60 * 60;
const MAX_FIELD_LENGTH = 2048;

function getVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** Length-safe constant-time string comparison. */
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function isNonEmptyString(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FIELD_LENGTH
  );
}

function parseSubscription(body) {
  const { endpoint, keys } = body || {};
  let url = null;
  if (isNonEmptyString(endpoint)) {
    try {
      url = new URL(endpoint);
    } catch {
      url = null;
    }
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    !keys ||
    !isNonEmptyString(keys.p256dh) ||
    !isNonEmptyString(keys.auth)
  ) {
    throw createError(400, 'Invalid push subscription.');
  }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

function buildNotification(report) {
  const suffix =
    report.periodType === 'OT' || report.periodType === 'SO'
      ? ` (${report.periodType})`
      : '';
  return {
    title: 'After Action Report',
    body: `${report.awayTeam} ${report.awayScore} @ ${report.homeTeam} ${report.homeScore}${suffix}`,
  };
}

/**
 * Web Push slice: device subscriptions, the sent ledger, and the cron-driven
 * dispatch. Nothing runs on a timer inside the API; GitHub Actions calls
 * `dispatch` through the secured route.
 *
 * @param {{
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 *   sessionJwt: typeof import('#platform/sessionJwt.js'),
 *   afterActionReportService: ReturnType<typeof import('#slices/afterActionReports/afterActionReportService.js').createAfterActionReportService>,
 *   webPush?: { sendNotification: Function },
 *   now?: () => number,
 * }} deps
 */
function createPushNotificationService({
  withTransaction,
  sessionJwt,
  afterActionReportService,
  webPush = require('web-push'),
  now = () => Date.now(),
}) {
  function requireConfigured() {
    const vapid = getVapid();
    if (!vapid)
      throw createError(503, 'Push notifications are not configured.');
    return vapid;
  }

  async function sendToSubscription(subscription, payload, vapid) {
    await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        TTL: PUSH_TTL_SECONDS,
        urgency: 'normal',
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      },
    );
  }

  return {
    getConfig() {
      const vapid = getVapid();
      return vapid
        ? { enabled: true, publicKey: vapid.publicKey }
        : { enabled: false, publicKey: null };
    },

    async subscribe(userId, body) {
      requireConfigured();
      const subscription = parseSubscription(body);
      await withTransaction((client) =>
        repository.upsertSubscription(client, { userId, ...subscription }),
      );
      // Opt-in never pushes anything old: everything already in the inbox is
      // recorded as sent.
      const { reports } = await afterActionReportService.listReports(userId);
      await withTransaction((client) =>
        repository.insertLedgerGameIds(client, {
          userId,
          gameIds: reports.map((report) => report.gameId),
        }),
      );
    },

    async unsubscribe(userId, body) {
      const endpoint = (body || {}).endpoint;
      if (!isNonEmptyString(endpoint)) return;
      await withTransaction((client) =>
        repository.deleteSubscriptionForUser(client, { userId, endpoint }),
      );
    },

    /** Marks the token's game read for the token's user. 401 on any bad token. */
    async markReadFromToken(token) {
      let claims;
      try {
        claims = sessionJwt.verifyReadToken(token);
      } catch {
        throw createError(401, 'Unauthorized');
      }
      await afterActionReportService.markRead(claims.userId, claims.gameId);
    },

    /** Throws 503 when dispatch is unconfigured, 401 on a bad bearer secret. */
    assertDispatchAuthorized(authorizationHeader) {
      const secret = process.env.CRON_SECRET;
      if (!secret || !getVapid()) {
        throw createError(503, 'Push dispatch is not configured.');
      }
      const [scheme, token] = String(authorizationHeader || '').split(' ');
      if (scheme !== 'Bearer' || !token || !safeEqual(token, secret)) {
        throw createError(401, 'Unauthorized');
      }
    },

    async dispatch() {
      const vapid = requireConfigured();
      const userIds = await withTransaction((client) =>
        repository.listSubscriptionUserIds(client),
      );
      const summary = { users: userIds.length, sent: 0, removed: 0 };
      if (userIds.length === 0) return summary;

      const favoritesByUser = new Map();
      const triCodes = new Set();
      for (const userId of userIds) {
        const favorites = await afterActionReportService.listFavorites(userId);
        favoritesByUser.set(userId, favorites);
        for (const { triCode } of favorites) triCodes.add(triCode);
      }
      if (triCodes.size === 0) return summary;

      // One fresh schedule load per distinct team, shared by every user.
      const gamesByTeam = await afterActionReportService.loadGamesByTeam(
        [...triCodes],
        { fresh: true },
      );
      const cutoff = now() - MAX_GAME_AGE_MS;

      for (const userId of userIds) {
        try {
          await dispatchForUser({
            userId,
            favorites: favoritesByUser.get(userId),
            gamesByTeam,
            cutoff,
            summary,
            vapid,
          });
        } catch (error) {
          console.error(
            `Push dispatch failed for user ${userId}:`,
            error?.message ?? error,
          );
        }
      }
      return summary;
    },
  };

  async function dispatchForUser({
    userId,
    favorites,
    gamesByTeam,
    cutoff,
    summary,
    vapid,
  }) {
    if (favorites.length === 0) return;
    const { reports } = await afterActionReportService.listReports(userId, {
      favorites,
      gamesByTeam,
    });
    const mutedByTeam = new Map(
      favorites.map((favorite) => [favorite.triCode, favorite.pushMuted]),
    );
    const fresh = reports.filter((report) => {
      if (report.read) return false;
      const startMs = Date.parse(report.gameTime);
      return Number.isFinite(startMs) && startMs >= cutoff;
    });
    if (fresh.length === 0) return;

    const alreadySent = new Set(
      await withTransaction((client) =>
        repository.listLedgerGameIds(client, {
          userId,
          gameIds: fresh.map((report) => report.gameId),
        }),
      ),
    );

    for (const report of fresh) {
      if (alreadySent.has(report.gameId)) continue;
      // Claim before sending so concurrent dispatches cannot double send.
      const claimed = await withTransaction((client) =>
        repository.claimPush(client, { userId, gameId: report.gameId }),
      );
      // A game whose favorites are all muted is claimed but never sent, so
      // unmuting later does not push a game that finished while muted.
      const unmuted = report.favoriteTeams.some(
        (team) => mutedByTeam.get(team) === false,
      );
      if (!claimed || !unmuted) continue;

      const subscriptions = await withTransaction((client) =>
        repository.listSubscriptionsForUser(client, userId),
      );
      const payload = {
        ...buildNotification(report),
        gameId: report.gameId,
        tag: `aar-${report.gameId}`,
        readToken: sessionJwt.signReadToken({ userId, gameId: report.gameId }),
      };
      for (const subscription of subscriptions) {
        try {
          await sendToSubscription(subscription, payload, vapid);
          summary.sent += 1;
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            await withTransaction((client) =>
              repository.deleteSubscriptionById(client, subscription.id),
            );
            summary.removed += 1;
          } else {
            console.error(
              `Push send failed (user ${userId}, game ${report.gameId}):`,
              error?.statusCode ?? '',
              error?.message ?? error,
            );
          }
        }
      }
    }
  }
}

module.exports = { createPushNotificationService };
