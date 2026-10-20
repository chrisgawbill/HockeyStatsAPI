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

/** Reads the VAPID keys from the environment, or null when push is not configured. */
function readVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** Length-safe constant-time string comparison. */
function secretsMatch(candidate, expected) {
  const candidateDigest = crypto
    .createHash('sha256')
    .update(String(candidate))
    .digest();
  const expectedDigest = crypto
    .createHash('sha256')
    .update(String(expected))
    .digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

/** True for a non-empty string no longer than MAX_FIELD_LENGTH. */
function isNonEmptyString(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FIELD_LENGTH
  );
}

/** Parses a string as a URL, or returns null when it is not one. */
function parseUrlOrNull(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** Validates a browser PushSubscription JSON body (https endpoint plus keys); throws 400 otherwise. */
function parseSubscription(body) {
  const { endpoint, keys } = body || {};
  const endpointUrl = isNonEmptyString(endpoint)
    ? parseUrlOrNull(endpoint)
    : null;
  if (
    !endpointUrl ||
    endpointUrl.protocol !== 'https:' ||
    !keys ||
    !isNonEmptyString(keys.p256dh) ||
    !isNonEmptyString(keys.auth)
  ) {
    throw createError(400, 'Invalid push subscription.');
  }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/** Every forward and defenseman from both teams of a boxscore. */
function listBoxscoreSkaters(boxscore) {
  return ['homeTeam', 'awayTeam'].flatMap((side) => {
    const sideStats = boxscore?.playerByGameStats?.[side];
    return [...(sideStats?.forwards ?? []), ...(sideStats?.defense ?? [])];
  });
}

/** Describes a skater's goals and assists, e.g. "Name: 2 goals, 1 assist — hat trick!"; null with no points. */
function describeScoringLine(favorite, skater) {
  const goals = Number(skater.goals) || 0;
  const assists = Number(skater.assists) || 0;
  const points = goals + assists;
  if (points === 0) return null;
  const statParts = [];
  if (goals) statParts.push(`${goals} goal${goals === 1 ? '' : 's'}`);
  if (assists) statParts.push(`${assists} assist${assists === 1 ? '' : 's'}`);
  const milestone =
    goals >= 3
      ? ' — hat trick!'
      : points >= 2
        ? ` — ${points}-point game!`
        : '';
  return `${favorite.name}: ${statParts.join(', ')}${milestone}`;
}

/**
 * Builds the push title and body for a finished game: a line for each favorite
 * player who scored (when the boxscore is available) followed by the final score.
 */
function buildNotification(report, favorites = [], boxscore) {
  const suffix =
    report.periodType === 'OT' || report.periodType === 'SO'
      ? ` (${report.periodType})`
      : '';
  const skaters = listBoxscoreSkaters(boxscore);
  const highlights = favorites.flatMap((favorite) => {
    const skater = skaters.find(
      (boxscoreSkater) => Number(boxscoreSkater.playerId) === favorite.playerId,
    );
    const scoringLine = skater && describeScoringLine(favorite, skater);
    return scoringLine ? [scoringLine] : [];
  });
  const score = `${report.awayTeam} ${report.awayScore} @ ${report.homeTeam} ${report.homeScore}${suffix}`;
  return {
    title: 'After Action Report',
    body: [...highlights, score].join(' · '),
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
 *   scheduleService: ReturnType<typeof import('#slices/schedule/scheduleService.js').createScheduleService>,
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
  /** Returns the VAPID config, or throws 503 when push is not configured. */
  function requireVapidConfig() {
    const vapid = readVapidConfig();
    if (!vapid)
      throw createError(503, 'Push notifications are not configured.');
    return vapid;
  }

  /** Sends one payload to one stored device subscription. */
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

  /**
   * Opt-in never pushes anything old: records every report already in the
   * user's inbox (games and weeks) as sent.
   */
  async function markExistingReportsAsSent(userId) {
    const { reports } = await afterActionReportService.listReports(userId);
    await withTransaction(async (client) => {
      await repository.insertLedgerGameIds(client, {
        userId,
        gameIds: reports.map((report) => report.gameId),
      });
      await repository.seedWeeklyLedger(client, userId);
    });
  }

  /**
   * Verifies a read token as either a game (After Action Report) token or a
   * weekly report token; 401 when it is neither.
   */
  function verifyAnyReadToken(token) {
    try {
      return { gameToken: sessionJwt.verifyReadToken(token) };
    } catch {
      try {
        return { weekToken: sessionJwt.verifyWeeklyReadToken(token) };
      } catch {
        throw createError(401, 'Unauthorized');
      }
    }
  }

  /** Validates that `weekStart` is a Monday whose week has already ended (Eastern time). */
  function requireCompletedWeek(weekStart) {
    if (
      !isWeekStart(weekStart) ||
      weekEndOf(weekStart) >= easternClock(now()).date
    ) {
      throw createError(400, 'weekStart must be a completed Monday week.');
    }
  }

  /**
   * Lists the week's unread reports belonging to users who have a device
   * subscribed and have not switched the weekly push off.
   */
  async function listWeeklyPushRecipients(weekStart) {
    const [subscribedUserIds, optedOutUserIds, weekReports] =
      await Promise.all([
        withTransaction((client) => repository.listSubscriptionUserIds(client)),
        withTransaction((client) => repository.listWeeklyPushOptOuts(client)),
        weeklyPlayerReportService.listReportsForWeek(weekStart),
      ]);
    const subscribedIds = new Set(subscribedUserIds.map(String));
    const optedOutIds = new Set(optedOutUserIds);
    return weekReports.filter(({ userId, read }) => {
      const userIdText = String(userId);
      return (
        !read &&
        subscribedIds.has(userIdText) &&
        !optedOutIds.has(userIdText)
      );
    });
  }

  /** Claims and pushes one user's weekly report; does nothing if already claimed. */
  async function pushWeeklyReport({
    userId,
    report,
    weekStart,
    vapid,
    summary,
  }) {
    const claimed = await withTransaction((client) =>
      repository.claimWeeklyPush(client, { userId, weekStart }),
    );
    if (!claimed) return;
    const payload = {
      kind: 'weekly-report',
      title: `Weekly Player Report · ${report.label}`,
      body: report.headline,
      weekStart,
      tag: `wpr-${weekStart}`,
      readToken: sessionJwt.signWeeklyReadToken({ userId, weekStart }),
    };
    await sendToUser(userId, payload, vapid, summary, `week ${weekStart}`);
  }

  /** Loads every subscribed user's favorite teams and the distinct team codes among them. */
  async function loadFavoriteTeams(userIds) {
    const favoritesByUser = new Map();
    const triCodes = new Set();
    for (const userId of userIds) {
      const favorites = await afterActionReportService.listFavorites(userId);
      favoritesByUser.set(userId, favorites);
      for (const { triCode } of favorites) triCodes.add(triCode);
    }
    return { favoritesByUser, triCodes };
  }

  /** Fetches a game's boxscore once per dispatch run; a failure resolves to null. */
  function getBoxscoreOnce(boxscores, gameId) {
    if (!boxscores.has(gameId)) {
      boxscores.set(
        gameId,
        scheduleService.getGameBoxscore(gameId).catch((error) => {
          console.error(`Push boxscore ${gameId} failed:`, error?.message);
          return null;
        }),
      );
    }
    return boxscores.get(gameId);
  }

  /** Reports that are unread and whose game started no earlier than `cutoff`. */
  function selectFreshUnreadReports(reports, cutoff) {
    return reports.filter((report) => {
      if (report.read) return false;
      const startMs = Date.parse(report.gameTime);
      return Number.isFinite(startMs) && startMs >= cutoff;
    });
  }

  /** Pushes one user's not-yet-sent, recent After Action Reports for their unmuted favorite teams. */
  async function dispatchForUser({
    userId,
    favorites,
    gamesByTeam,
    cutoff,
    summary,
    vapid,
    boxscores,
  }) {
    if (favorites.length === 0) return;
    const { reports } = await afterActionReportService.listReports(userId, {
      favorites,
      gamesByTeam,
    });
    const mutedByTeam = new Map(
      favorites.map((favorite) => [favorite.triCode, favorite.pushMuted]),
    );
    const freshReports = selectFreshUnreadReports(reports, cutoff);
    if (freshReports.length === 0) return;

    const alreadySentGameIds = new Set(
      await withTransaction((client) =>
        repository.listLedgerGameIds(client, {
          userId,
          gameIds: freshReports.map((report) => report.gameId),
        }),
      ),
    );

    const favoritePlayers =
      await weeklyPlayerReportService.listFavorites(userId);
    for (const report of freshReports) {
      if (alreadySentGameIds.has(report.gameId)) continue;
      // Claim before sending so concurrent dispatches cannot double send.
      const claimed = await withTransaction((client) =>
        repository.claimPush(client, { userId, gameId: report.gameId }),
      );
      // A game whose favorites are all muted is claimed but never sent, so
      // unmuting later does not push a game that finished while muted.
      const hasUnmutedTeam = report.favoriteTeams.some(
        (team) => mutedByTeam.get(team) === false,
      );
      if (!claimed || !hasUnmutedTeam) continue;

      const boxscore =
        favoritePlayers.length > 0
          ? await getBoxscoreOnce(boxscores, report.gameId)
          : undefined;
      const payload = {
        ...buildNotification(report, favoritePlayers, boxscore),
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

  return {
    /** Public push config: whether push is enabled and the VAPID public key. */
    getConfig() {
      const vapid = readVapidConfig();
      return vapid
        ? { enabled: true, publicKey: vapid.publicKey }
        : { enabled: false, publicKey: null };
    },

    /** Stores the device subscription and seeds the sent ledger so old reports are not pushed. */
    async subscribe(userId, body) {
      requireVapidConfig();
      const subscription = parseSubscription(body);
      await withTransaction((client) =>
        repository.upsertSubscription(client, { userId, ...subscription }),
      );
      await markExistingReportsAsSent(userId);
    },

    /** Removes the user's subscription for an endpoint; a missing endpoint is ignored. */
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
      const { gameToken, weekToken } = verifyAnyReadToken(token);
      if (gameToken) {
        await afterActionReportService.markRead(
          gameToken.userId,
          gameToken.gameId,
        );
      } else {
        await weeklyPlayerReportService.markRead(
          weekToken.userId,
          weekToken.weekStart,
        );
      }
    },

    /** Whether the user's weekly report push is switched on. */
    async getWeeklyReportPush(userId) {
      const enabled = await withTransaction((client) =>
        repository.getWeeklyReportPush(client, userId),
      );
      return { enabled };
    },

    /** Switches the user's weekly report push on or off; `enabled` must be a boolean. */
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
      const vapid = requireVapidConfig();
      const targetWeekStart = weekStart ?? previousWeekStart(now());
      requireCompletedWeek(targetWeekStart);
      const generation =
        await weeklyPlayerReportService.generateWeek(targetWeekStart);
      const summary = {
        weekStart: targetWeekStart,
        ...generation,
        users: 0,
        sent: 0,
        removed: 0,
      };
      if (generation.skipped) return summary;

      const recipients = await listWeeklyPushRecipients(targetWeekStart);
      for (const { userId, report } of recipients) {
        summary.users += 1;
        try {
          await pushWeeklyReport({
            userId,
            report,
            weekStart: targetWeekStart,
            vapid,
            summary,
          });
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
      if (!secret || !readVapidConfig()) {
        throw createError(503, 'Push dispatch is not configured.');
      }
      const [scheme, token] = String(authorizationHeader || '').split(' ');
      if (scheme !== 'Bearer' || !token || !secretsMatch(token, secret)) {
        throw createError(401, 'Unauthorized');
      }
    },

    /**
     * After Action Report dispatch: pushes each subscribed user's recent
     * finished games for their unmuted favorite teams, once per game. Schedules
     * are loaded fresh once per distinct team and shared by every user.
     */
    async dispatch() {
      const vapid = requireVapidConfig();
      const userIds = await withTransaction((client) =>
        repository.listSubscriptionUserIds(client),
      );
      const summary = { users: userIds.length, sent: 0, removed: 0 };
      if (userIds.length === 0) return summary;

      const { favoritesByUser, triCodes } = await loadFavoriteTeams(userIds);
      if (triCodes.size === 0) return summary;

      const gamesByTeam = await afterActionReportService.loadGamesByTeam(
        [...triCodes],
        { fresh: true },
      );
      const cutoff = now() - MAX_GAME_AGE_MS;
      const boxscores = new Map();

      for (const userId of userIds) {
        try {
          await dispatchForUser({
            userId,
            favorites: favoritesByUser.get(userId),
            gamesByTeam,
            cutoff,
            summary,
            vapid,
            boxscores,
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
}

module.exports = { createPushNotificationService, buildNotification };
