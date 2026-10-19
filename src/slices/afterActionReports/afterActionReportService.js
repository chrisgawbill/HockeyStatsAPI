const createError = require('http-errors');
const repository = require('#slices/afterActionReports/afterActionReportRepository.js');

const TRI_CODE_PATTERN = /^[A-Z]{3}$/;
const COMPLETED_GAME_STATES = new Set(['OFF', 'FINAL']);
const MAX_REPORTS = 25;
/**
 * A game counts for a favorite when it started no more than this long before
 * the team was favorited, so favoriting mid-game or right after the final
 * horn still produces tonight's report, but never last night's.
 */
const FAVORITE_GRACE_MS = 12 * 60 * 60 * 1000;

/**
 * Whether `game` started late enough to report for a team favorited at
 * `since`. Falls back to the calendar date when the start time is missing.
 */
function startedAfterFavorite(game, since) {
  const sinceMs = Date.parse(since);
  const startMs = Date.parse(game.gameTime);
  if (Number.isFinite(startMs) && Number.isFinite(sinceMs)) {
    return startMs >= sinceMs - FAVORITE_GRACE_MS;
  }
  return Boolean(game.date) && game.date >= since.slice(0, 10);
}

/**
 * Pure report builder. A favorite produces an After Action Report for every
 * completed game it started around or after favoriting (see
 * FAVORITE_GRACE_MS), so a new favorite never floods the inbox with the
 * season's back catalogue. A game between two favorites yields one report
 * naming both. Newest first.
 *
 * @param {{
 *   favorites: { triCode: string, since: string }[],
 *   gamesByTeam: Record<string, any[]>,
 *   readGameIds: Iterable<number>,
 *   limit?: number,
 * }} input
 */
function buildAfterActionReports({
  favorites,
  gamesByTeam,
  readGameIds,
  limit = MAX_REPORTS,
}) {
  const read = new Set(readGameIds);
  const byGameId = new Map();

  for (const { triCode, since } of favorites) {
    for (const game of gamesByTeam[triCode] ?? []) {
      if (!COMPLETED_GAME_STATES.has(game.gameState)) continue;
      if (!startedAfterFavorite(game, since)) continue;

      const existing = byGameId.get(game.gameId);
      if (existing) {
        if (!existing.favoriteTeams.includes(triCode)) {
          existing.favoriteTeams.push(triCode);
        }
        continue;
      }
      byGameId.set(game.gameId, {
        gameId: game.gameId,
        date: game.date,
        gameTime: game.gameTime,
        homeTeam: game.homeTeam,
        homeLogo: game.homeLogo,
        homeScore: game.homeScore,
        awayTeam: game.awayTeam,
        awayLogo: game.awayLogo,
        awayScore: game.awayScore,
        periodType: game.periodType ?? null,
        isPlayoff: Boolean(game.isPlayoff),
        favoriteTeams: [triCode],
        read: read.has(game.gameId),
      });
    }
  }

  const reports = [...byGameId.values()]
    .sort((a, b) =>
      a.date === b.date
        ? String(b.gameTime).localeCompare(String(a.gameTime))
        : b.date.localeCompare(a.date),
    )
    .slice(0, limit);

  return {
    reports,
    unreadCount: reports.filter((report) => !report.read).length,
  };
}

/** Season games overlaid with the fresher current-week games, keyed by id. */
function mergeTeamGames(seasonGames, recentGames) {
  const byId = new Map();
  for (const game of seasonGames ?? []) byId.set(game.gameId, game);
  for (const game of recentGames ?? []) byId.set(game.gameId, game);
  return [...byId.values()];
}

function normalizeTriCode(triCode) {
  const normalized = String(triCode ?? '').toUpperCase();
  if (!TRI_CODE_PATTERN.test(normalized)) {
    throw createError(400, 'Invalid team tri-code.');
  }
  return normalized;
}

function normalizeGameId(gameId) {
  const normalized = Number(gameId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw createError(400, 'Invalid game id.');
  }
  return normalized;
}

function toFavorite(row) {
  return {
    triCode: row.team_tri_code,
    since: new Date(row.created_at).toISOString(),
  };
}

/**
 * After Action Reports slice: a signed-in user's favorite teams and the
 * per-game reports derived from them. Reports are computed on request from
 * cached schedule data rather than written by a background job, because the
 * hosted API sleeps when idle; only favorites and read receipts are stored.
 *
 * @param {{
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 *   seasons: typeof import('#platform/seasonHelper.js'),
 *   scheduleService: ReturnType<typeof import('#slices/schedule/scheduleService.js').createScheduleService>,
 * }} deps
 */
function createAfterActionReportService({
  withTransaction,
  seasons,
  scheduleService,
}) {
  async function listFavorites(userId) {
    const rows = await withTransaction((client) =>
      repository.listFavoriteTeams(client, userId),
    );
    return rows.map(toFavorite);
  }

  /**
   * One failing team schedule must not empty the whole inbox, so each team is
   * settled independently and a failure contributes no games.
   */
  async function loadGamesByTeam(triCodes) {
    const seasonId = seasons.getCurrentSeasonId();
    const settled = await Promise.allSettled(
      triCodes.map(async (triCode) => {
        const [season, recent] = await Promise.allSettled([
          scheduleService.getTeamSchedule(triCode, seasonId),
          scheduleService.getRecentTeamGames(triCode),
        ]);
        if (season.status === 'rejected' && recent.status === 'rejected') {
          throw season.reason;
        }
        return mergeTeamGames(
          season.status === 'fulfilled' ? season.value.games : [],
          recent.status === 'fulfilled' ? recent.value.games : [],
        );
      }),
    );

    const gamesByTeam = {};
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        gamesByTeam[triCodes[index]] = result.value;
      } else {
        console.error(
          `After Action Reports: schedule for ${triCodes[index]} failed:`,
          result.reason?.message ?? result.reason,
        );
      }
    });
    return gamesByTeam;
  }

  async function listReports(userId) {
    const favorites = await listFavorites(userId);
    if (favorites.length === 0) {
      return { reports: [], unreadCount: 0 };
    }

    const gamesByTeam = await loadGamesByTeam(
      favorites.map((favorite) => favorite.triCode),
    );
    const candidate = buildAfterActionReports({
      favorites,
      gamesByTeam,
      readGameIds: [],
    });
    const readGameIds = await withTransaction((client) =>
      repository.listReadGameIds(client, {
        userId,
        gameIds: candidate.reports.map((report) => report.gameId),
      }),
    );
    return buildAfterActionReports({ favorites, gamesByTeam, readGameIds });
  }

  return {
    listFavorites,

    async addFavorite(userId, triCode) {
      const normalized = normalizeTriCode(triCode);
      await withTransaction((client) =>
        repository.insertFavoriteTeam(client, { userId, triCode: normalized }),
      );
      return { favorites: await listFavorites(userId) };
    },

    async removeFavorite(userId, triCode) {
      const normalized = normalizeTriCode(triCode);
      await withTransaction((client) =>
        repository.deleteFavoriteTeam(client, { userId, triCode: normalized }),
      );
      return { favorites: await listFavorites(userId) };
    },

    listReports,

    async markRead(userId, gameId) {
      const normalized = normalizeGameId(gameId);
      await withTransaction((client) =>
        repository.insertReadGameIds(client, {
          userId,
          gameIds: [normalized],
        }),
      );
    },

    /** Marks every report currently in the inbox as read. */
    async markAllRead(userId) {
      const { reports } = await listReports(userId);
      const unread = reports.filter((report) => !report.read);
      await withTransaction((client) =>
        repository.insertReadGameIds(client, {
          userId,
          gameIds: unread.map((report) => report.gameId),
        }),
      );
      return {
        reports: reports.map((report) => ({ ...report, read: true })),
        unreadCount: 0,
      };
    },
  };
}

module.exports = {
  createAfterActionReportService,
  buildAfterActionReports,
  mergeTeamGames,
};
