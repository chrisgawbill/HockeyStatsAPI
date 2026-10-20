const crypto = require('crypto');
const createError = require('http-errors');
const repository = require('#slices/pushNotifications/pushNotificationRepository.js');
const {
  easternClock,
  isWeekStart,
  previousWeekStart,
  weekEndOf,
} = require('#slices/weeklyPlayerReports/weeklyReportBuilder.js');

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

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** One line for a player's night, or null when there is nothing to call out. */
function describePlayerGame(name, stats) {
  if (stats.isGoalie) {
    return stats.decision === 'W' && stats.goalsAgainst === 0
      ? `${name} posted a shutout`
      : null;
  }
  const goals = Number(stats.goals) || 0;
  const assists = Number(stats.assists) || 0;
  const points = goals + assists;
  if (points === 0) return null;
  const parts = [goals > 0 && `${goals}G`, assists > 0 && `${assists}A`]
    .filter(Boolean)
    .join(', ');
  if (goals >= 3) return `${name} had a hat trick (${parts})`;
  if (points >= 2) return `${name} had a ${points}-point game (${parts})`;
  return goals === 1 ? `${name} scored` : `${name} had an assist`;
}

/**
 * Highlight lines for the user's favorite players in a gamecenter boxscore
 * (goals, assists, multi-point games, hat tricks, goalie shutouts).
 */
function favoritePlayerHighlights(boxscore, favoritePlayers) {
  const favoriteIds = new Set(favoritePlayers.map((p) => Number(p.playerId)));
  const highlights = [];
  for (const side of ['awayTeam', 'homeTeam']) {
    const team = boxscore?.playerByGameStats?.[side] ?? {};
    const groups = [
      ...(team.forwards ?? []),
      ...(team.defense ?? []),
      ...(team.goalies ?? []).map((g) => ({ ...g, isGoalie: true })),
    ];
    for (const stats of groups) {
      if (!favoriteIds.has(Number(stats.playerId))) continue;
      const name =
        stats.name?.default ??
        favoritePlayers.find((p) => p.playerId === Number(stats.playerId))
          ?.name;
      const line = name && describePlayerGame(name, stats);
      if (line) highlights.push(line);
    }
  }
  return highlights;
}

function buildNotification(report, highlights = []) {
  const suffix =
    report.periodType === 'OT' || report.periodType === 'SO'
      ? ` (${report.periodType})`
      : '';
  const score = `${report.awayTeam} ${report.awayScore} @ ${report.homeTeam} ${report.homeScore}${suffix}`;
  return {
    title: 'After Action Report',
    body: highlights.length
      ? `${score}\n${highlights.map((line) => `⭐ ${line}`).join('\n')}`
      : score,
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
 *   weeklyPlayerReportService: ReturnType<typeof import('#slices/weeklyPlayerReports/weeklyPlayerReportService.js').createWeeklyPlayerReportService>,
 *   scheduleService?: { getGameBoxscore: (gameId: number) => Promise<object> },
 *   webPush?: { sendNotification: Function },
 *   now?: () => number,
 * }} deps
 */
function createPushNotificationService({
  withTransaction,
  sessionJwt,
  afterActionReportService,
  weeklyPlayerReportService,
  scheduleService,
  webPush = require('web-push'),
  now = () => Date.now(),
}) {
  function requireConfigured() {
    const vapid = getVapid();
    if (!vapid)
      throw createError(503, 'Push notifications are not configured.');
    return vapid;
  }

  /**
   * Favorite-player lines for one game. Best effort: a missing boxscore or
   * favorites lookup just sends the plain score.
   */
  async function highlightsFor(userId, report, cache) {
    if (!scheduleService?.getGameBoxscore || !weeklyPlayerReportService)
      return [];
    try {
      cache.favoritePlayers ??=
        await weeklyPlayerReportService.listFavorites(userId);
      if (cache.favoritePlayers.length === 0) return [];
      const boxscore = await scheduleService.getGameBoxscore(report.gameId);
      return favoritePlayerHighlights(boxscore, cache.favoritePlayers);
    } catch (error) {
      console.error(
        `Favorite player highlights failed (user ${userId}, game ${report.gameId}):`,
        error?.message ?? error,
      );
      return [];
    }
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

  /**
   * Sends one payload to every device of `userId`, deleting subscriptions the
   * push service reports gone (404/410) and counting into `summary`.
   */
  async function sendToUser(userId, payload, vapid, summary, label) {
    const subscriptions = await withTransaction((client) =>
      repository.listSubscriptionsForUser(client, userId),
    );
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
            `Push send failed (user ${userId}, ${label}):`,
            error?.statusCode ?? '',
            error?.message ?? error,
          );
        }
      }
    }
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
      await withTransaction(async (client) => {
        await repository.insertLedgerGameIds(client, {
          userId,
          gameIds: reports.map((report) => report.gameId),
        });
        await repository.seedWeeklyLedger(client, userId);
      });
    },

    async unsubscribe(userId, body) {
      const endpoint = (body || {}).endpoint;
      if (!isNonEmptyString(endpoint)) return;
      await withTransaction((client) =>
        repository.deleteSubscriptionForUser(client, { userId, endpoint }),
      );
    },

    /**
     * Marks the token's game (After Action Report) or week (Weekly Player
     * Report) read for the token's user. 401 on any bad token.
     */
    async markReadFromToken(token) {
      let game = null;
      let week = null;
      try {
        game = sessionJwt.verifyReadToken(token);
      } catch {
        try {
          week = sessionJwt.verifyWeeklyReadToken(token);
        } catch {
          throw createError(401, 'Unauthorized');
        }
      }
      if (game) {
        await afterActionReportService.markRead(game.userId, game.gameId);
      } else {
        await weeklyPlayerReportService.markRead(week.userId, week.weekStart);
      }
    },

    async getWeeklyReportPush(userId) {
      const enabled = await withTransaction((client) =>
        repository.getWeeklyReportPush(client, userId),
      );
      return { enabled };
    },

    async setWeeklyReportPush(userId, enabled) {
      if (typeof enabled !== 'boolean') {
        throw createError(400, 'enabled must be a boolean.');
      }
      await withTransaction((client) =>
        repository.setWeeklyReportPush(client, { userId, enabled }),
      );
      return { enabled };
    },

    /**
     * Monday dispatch: generates last week's Weekly Player Reports (or skips
     * a league-break week), then pushes each new, unread report once to users
     * who have a device subscribed and the weekly switch on. `weekStart`
     * overrides the week (manual reruns); it must be a completed week.
     */
    async weeklyDispatch({ weekStart } = {}) {
      const vapid = requireConfigured();
      const week = weekStart ?? previousWeekStart(now());
      if (!isWeekStart(week) || weekEndOf(week) >= easternClock(now()).date) {
        throw createError(400, 'weekStart must be a completed Monday week.');
      }
      const generated = await weeklyPlayerReportService.generateWeek(week);
      const summary = {
        weekStart: week,
        ...generated,
        users: 0,
        sent: 0,
        removed: 0,
      };
      if (generated.skipped) return summary;

      const [subscribed, optedOut, reports] = await Promise.all([
        withTransaction((client) => repository.listSubscriptionUserIds(client)),
        withTransaction((client) => repository.listWeeklyPushOptOuts(client)),
        weeklyPlayerReportService.listReportsForWeek(week),
      ]);
      const subscribedIds = new Set(subscribed.map(String));
      const optedOutIds = new Set(optedOut);

      for (const { userId, report, read } of reports) {
        const id = String(userId);
        if (read || !subscribedIds.has(id) || optedOutIds.has(id)) continue;
        summary.users += 1;
        try {
          const claimed = await withTransaction((client) =>
            repository.claimWeeklyPush(client, { userId, weekStart: week }),
          );
          if (!claimed) continue;
          const payload = {
            kind: 'weekly-report',
            title: `Weekly Player Report · ${report.label}`,
            body: report.headline,
            weekStart: week,
            tag: `wpr-${week}`,
            readToken: sessionJwt.signWeeklyReadToken({
              userId,
              weekStart: week,
            }),
          };
          await sendToUser(userId, payload, vapid, summary, `week ${week}`);
        } catch (error) {
          console.error(
            `Weekly push failed for user ${userId}:`,
            error?.message ?? error,
          );
        }
      }
      return summary;
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

    const highlightCache = {};
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

      const payload = {
        ...buildNotification(
          report,
          await highlightsFor(userId, report, highlightCache),
        ),
        gameId: report.gameId,
        tag: `aar-${report.gameId}`,
        readToken: sessionJwt.signReadToken({ userId, gameId: report.gameId }),
      };
      await sendToUser(
        userId,
        payload,
        vapid,
        summary,
        `game ${report.gameId}`,
      );
    }
  }
}

module.exports = { createPushNotificationService, favoritePlayerHighlights };
