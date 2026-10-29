const createError = require('http-errors');
const {
  DEFAULT_FAVORITE_TIER,
  parseCategoryUpdate,
} = require('#platform/favoriteCategory.js');
const repository = require('#slices/afterActionReports/afterActionReportRepository.js');

const TRI_CODE_PATTERNS = { nhl: /^[A-Z]{3}$/, ahl: /^[A-Z]{2,4}$/ };
const COMPLETED_GAME_STATES = new Set(['OFF', 'FINAL']);
const MAX_REPORTS = 25;
const MAX_FAVORITE_TEAMS = 5;
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
  const readGameIdSet = new Set(readGameIds);
  const reportsByGameId = new Map();

  for (const { triCode, since } of favorites) {
    for (const game of gamesByTeam[triCode] ?? []) {
      if (!COMPLETED_GAME_STATES.has(game.gameState)) continue;
      if (!startedAfterFavorite(game, since)) continue;

      const existingReport = reportsByGameId.get(game.gameId);
      if (existingReport) {
        if (!existingReport.favoriteTeams.includes(triCode)) {
          existingReport.favoriteTeams.push(triCode);
        }
        continue;
      }
      reportsByGameId.set(game.gameId, {
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
        read: readGameIdSet.has(game.gameId),
      });
    }
  }

  const reports = [...reportsByGameId.values()]
    .sort((reportA, reportB) =>
      reportA.date === reportB.date
        ? String(reportB.gameTime).localeCompare(String(reportA.gameTime))
        : reportB.date.localeCompare(reportA.date),
    )
    .slice(0, limit);

  return {
    reports,
    unreadCount: reports.filter((report) => !report.read).length,
  };
}

/** Season games overlaid with the fresher current-week games, keyed by id. */
function mergeTeamGames(seasonGames, recentGames) {
  const gamesById = new Map();
  for (const game of seasonGames ?? []) gamesById.set(game.gameId, game);
  for (const game of recentGames ?? []) gamesById.set(game.gameId, game);
  return [...gamesById.values()];
}

/** Upper-cases and validates a team tri-code of `league` from user input; throws 400 if malformed. */
function parseTriCode(triCode, league = 'nhl') {
  const upperCaseTriCode = String(triCode ?? '').toUpperCase();
  if (!TRI_CODE_PATTERNS[league].test(upperCaseTriCode)) {
    throw createError(400, 'Invalid team tri-code.');
  }
  return upperCaseTriCode;
}

/** Parses a game id from user input; throws 400 unless it is a positive safe integer. */
function parseGameId(gameId) {
  const parsedGameId = Number(gameId);
  if (!Number.isSafeInteger(parsedGameId) || parsedGameId <= 0) {
    throw createError(400, 'Invalid game id.');
  }
  return parsedGameId;
}

/** Maps a favorite_teams row to the API shape. */
function mapFavoriteRow(favoriteRow) {
  return {
    league: favoriteRow.league,
    triCode: favoriteRow.team_tri_code,
    since: new Date(favoriteRow.created_at).toISOString(),
    pushMuted: Boolean(favoriteRow.push_muted),
    tier: favoriteRow.tier ?? DEFAULT_FAVORITE_TIER,
    label: favoriteRow.label ?? null,
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
 *   ahlReadService: ReturnType<typeof import('#slices/ahl/ahlReadService.js').createAhlReadService>,
 * }} deps
 */
function createAfterActionReportService({
  withTransaction,
  seasons,
  scheduleService,
  ahlReadService,
}) {
  /** The user's favorite teams in both leagues, in the API shape. */
  async function listFavorites(userId) {
    const favoriteRows = await withTransaction((client) =>
      repository.listFavoriteTeams(client, userId),
    );
    return favoriteRows.map(mapFavoriteRow);
  }

  /** The user's NHL favorite teams: the only ones reports and pushes cover. */
  async function listNhlFavorites(userId) {
    const favorites = await listFavorites(userId);
    return favorites.filter((favorite) => favorite.league === 'nhl');
  }

  /**
   * One failing team schedule must not empty the whole inbox, so each team is
   * settled independently and a failure contributes no games.
   */
  async function loadGamesByTeam(triCodes) {
    const seasonId = seasons.getCurrentSeasonId();
    const teamOutcomes = await Promise.allSettled(
      triCodes.map(async (triCode) => {
        const [seasonOutcome, recentOutcome] = await Promise.allSettled([
          scheduleService.getTeamSchedule(triCode, seasonId),
          scheduleService.getRecentTeamGames(triCode),
        ]);
        if (
          seasonOutcome.status === 'rejected' &&
          recentOutcome.status === 'rejected'
        ) {
          throw seasonOutcome.reason;
        }
        return mergeTeamGames(
          seasonOutcome.status === 'fulfilled' ? seasonOutcome.value.games : [],
          recentOutcome.status === 'fulfilled' ? recentOutcome.value.games : [],
        );
      }),
    );

    const gamesByTeam = {};
    teamOutcomes.forEach((teamOutcome, index) => {
      if (teamOutcome.status === 'fulfilled') {
        gamesByTeam[triCodes[index]] = teamOutcome.value;
      } else {
        console.error(
          `After Action Reports: schedule for ${triCodes[index]} failed:`,
          teamOutcome.reason?.message ?? teamOutcome.reason,
        );
      }
    });
    return gamesByTeam;
  }

  /**
   * @param {number|string} userId
   * @param {{ gamesByTeam?: Record<string, any[]>, favorites?: any[] }} [preloaded]
   *   Lets push dispatch share one schedule load across users.
   */
  async function listReports(userId, preloaded = {}) {
    const favorites = preloaded.favorites ?? (await listNhlFavorites(userId));
    if (favorites.length === 0) {
      return { reports: [], unreadCount: 0 };
    }

    const gamesByTeam =
      preloaded.gamesByTeam ??
      (await loadGamesByTeam(favorites.map((favorite) => favorite.triCode)));
    const candidateReports = buildAfterActionReports({
      favorites,
      gamesByTeam,
      readGameIds: [],
    });
    const readGameIds = await withTransaction((client) =>
      repository.listReadGameIds(client, {
        userId,
        gameIds: candidateReports.reports.map((report) => report.gameId),
      }),
    );
    return buildAfterActionReports({ favorites, gamesByTeam, readGameIds });
  }

  return {
    listFavorites,
    listNhlFavorites,
    loadGamesByTeam,

    /** Mutes or unmutes pushes for a favorite team; 404 if the team is not a favorite. */
    async setPushMuted(userId, triCode, muted, league = 'nhl') {
      const validTriCode = parseTriCode(triCode, league);
      if (typeof muted !== 'boolean') {
        throw createError(400, 'muted must be a boolean.');
      }
      const updatedCount = await withTransaction((client) =>
        repository.updateFavoritePushMuted(client, {
          userId,
          triCode: validTriCode,
          league,
          muted,
        }),
      );
      if (!updatedCount) throw createError(404, 'Team is not a favorite.');
      return { favorites: await listFavorites(userId) };
    },

    /** Sets a favorite team's tier and/or label and returns the updated favorites; 404 when not a favorite. */
    async updateCategory(userId, triCode, body, league = 'nhl') {
      const validTriCode = parseTriCode(triCode, league);
      const categoryChanges = parseCategoryUpdate(body);
      const updatedRowCount = await withTransaction((client) =>
        repository.updateFavoriteTeamCategory(client, {
          userId,
          triCode: validTriCode,
          league,
          ...categoryChanges,
        }),
      );
      if (!updatedRowCount) throw createError(404, 'Team is not a favorite.');
      return { favorites: await listFavorites(userId) };
    },

    /**
     * Favorites a team (409 past the cap shared by both leagues) and returns
     * the updated favorites. AHL teams must exist this season (404 otherwise).
     */
    async addFavorite(userId, triCode, league = 'nhl') {
      const validTriCode = parseTriCode(triCode, league);
      if (league === 'ahl') {
        await ahlReadService.findTeam(
          validTriCode,
          seasons.getCurrentSeasonId(),
        );
      }
      const added = await withTransaction((client) =>
        repository.insertFavoriteTeam(client, {
          userId,
          triCode: validTriCode,
          league,
          limit: MAX_FAVORITE_TEAMS,
        }),
      );
      if (!added) {
        throw createError(
          409,
          `You can favorite at most ${MAX_FAVORITE_TEAMS} teams.`,
        );
      }
      return { favorites: await listFavorites(userId) };
    },

    /** Removes a favorite team and returns the updated favorites. */
    async removeFavorite(userId, triCode, league = 'nhl') {
      const validTriCode = parseTriCode(triCode, league);
      await withTransaction((client) =>
        repository.deleteFavoriteTeam(client, {
          userId,
          triCode: validTriCode,
          league,
        }),
      );
      return { favorites: await listFavorites(userId) };
    },

    listReports,

    /** Marks one game's report read for the user. */
    async markRead(userId, gameId) {
      const validGameId = parseGameId(gameId);
      await withTransaction((client) =>
        repository.insertReadGameIds(client, {
          userId,
          gameIds: [validGameId],
        }),
      );
    },

    /** Marks every report currently in the inbox as read. */
    async markAllRead(userId) {
      const { reports } = await listReports(userId);
      const unreadReports = reports.filter((report) => !report.read);
      await withTransaction((client) =>
        repository.insertReadGameIds(client, {
          userId,
          gameIds: unreadReports.map((report) => report.gameId),
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
  MAX_FAVORITE_TEAMS,
  createAfterActionReportService,
  buildAfterActionReports,
  mergeTeamGames,
};
