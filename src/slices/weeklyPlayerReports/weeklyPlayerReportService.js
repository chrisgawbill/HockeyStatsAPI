const crypto = require('crypto');
const createError = require('http-errors');
const {
  DEFAULT_FAVORITE_TIER,
  parseCategoryUpdate,
} = require('#platform/favoriteCategory.js');
const { chunk } = require('#platform/batchSql.js');
const repository = require('#slices/weeklyPlayerReports/weeklyPlayerReportRepository.js');
const {
  isWeekStart,
  weekEndOf,
  summarizeWeekSchedule,
  normalizeGameRows,
  buildWeeklyReport,
} = require('#slices/weeklyPlayerReports/weeklyReportBuilder.js');

const MAX_FAVORITE_PLAYERS = 10;
const MAX_REPORTS = 12;
const STATS_PAGE_SIZE = 100;
const MAX_STATS_PAGES = 50;
/** Keeps each stats URL's `playerId in (...)` list a sane length. */
const PLAYER_ID_CHUNK = 50;

/** Parses a player id from user input; throws 400 unless it is a positive safe integer. */
function parsePlayerId(playerId) {
  const parsedPlayerId = Number(playerId);
  if (!Number.isSafeInteger(parsedPlayerId) || parsedPlayerId <= 0) {
    throw createError(400, 'Invalid player id.');
  }
  return parsedPlayerId;
}

/** Returns `weekStart` unchanged, or throws 400 unless it is a Monday date. */
function requireWeekStart(weekStart) {
  if (!isWeekStart(weekStart)) {
    throw createError(400, 'weekStart must be a Monday (YYYY-MM-DD).');
  }
  return weekStart;
}

/** Maps a favorite_players row (joined with the player) to the API shape. */
function mapFavoriteRow(favoriteRow) {
  return {
    playerId: Number(favoriteRow.player_id),
    name: favoriteRow.full_name,
    teamTriCode: favoriteRow.team_tri_code ?? null,
    position: favoriteRow.position ?? null,
    headshot: favoriteRow.headshot ?? null,
    since: new Date(favoriteRow.created_at).toISOString(),
    tier: favoriteRow.tier ?? DEFAULT_FAVORITE_TIER,
    label: favoriteRow.label ?? null,
  };
}

/** Maps a stored report row to the API shape, adding its week, creation time and read flag. */
function mapReportRow(reportRow) {
  return {
    ...reportRow.payload,
    weekStart: reportRow.week_start,
    createdAt: new Date(reportRow.created_at).toISOString(),
    read: Boolean(reportRow.read_at),
  };
}

/** Short stable hash of a player id list, for cache keys. */
function hashPlayerIds(playerIds) {
  return crypto
    .createHash('sha1')
    .update(playerIds.join(','))
    .digest('hex')
    .slice(0, 16);
}

/** Groups favorite rows by user id and collects the distinct skater and goalie ids. */
function groupFavoritesByUser(favoriteRows) {
  const favoritesByUser = new Map();
  const skaterIds = new Set();
  const goalieIds = new Set();
  for (const favoriteRow of favoriteRows) {
    const favorite = mapFavoriteRow(favoriteRow);
    const userFavorites = favoritesByUser.get(favoriteRow.user_id) ?? [];
    userFavorites.push(favorite);
    favoritesByUser.set(favoriteRow.user_id, userFavorites);
    (favorite.position === 'G' ? goalieIds : skaterIds).add(favorite.playerId);
  }
  return { favoritesByUser, skaterIds, goalieIds };
}

/** Sorts ids ascending so the same set always yields the same cache key. */
function sortIds(ids) {
  return [...ids].sort((firstId, secondId) => firstId - secondId);
}

/**
 * Weekly Player Report slice: favorite players, the frozen weekly reports,
 * and the generation half of the Monday dispatch (the push half lives in the
 * pushNotifications slice). Generation fetches everything from the NHL before
 * writing anything, so a failed call creates no reports.
 *
 * NHL calls per generated week: one league schedule (break check and team
 * game counts), then the stats REST per-game summaries for every distinct
 * favorited player across all users (one skater and one goalie query, paged).
 * Raw payloads are cached under keys that include the week, so a retried
 * dispatch reuses them; reports themselves are stored in Postgres.
 *
 * @param {{
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 *   nhlApi: typeof import('#platform/nhlApiClient.js'),
 *   cache: typeof import('#platform/cacheManager.js'),
 * }} deps
 */
function createWeeklyPlayerReportService({ withTransaction, nhlApi, cache }) {
  const { getOrFetchCached, CACHE_TYPES } = cache;

  /** The user's favorite players, in the API shape. */
  async function listFavorites(userId) {
    const favoriteRows = await withTransaction((client) =>
      repository.listFavoritePlayers(client, userId),
    );
    return favoriteRows.map(mapFavoriteRow);
  }

  /** Looks up a player's name, team, position and headshot on the NHL player landing. */
  async function fetchPlayerProfile(playerId) {
    const response = await nhlApi.axiosNhl.get(`/player/${playerId}/landing`);
    const landing = response.data ?? {};
    const firstName = landing.firstName?.default ?? landing.firstName ?? '';
    const lastName = landing.lastName?.default ?? landing.lastName ?? '';
    const fullName = `${firstName} ${lastName}`.trim();
    if (!fullName) throw createError(404, 'Player not found.');
    return {
      fullName,
      teamTriCode: landing.currentTeamAbbrev ?? null,
      position: landing.position ?? null,
      headshot: landing.headshot ?? null,
    };
  }

  /** Name/team/position for display, from the NHL player landing (24h cache). */
  async function getPlayerProfile(playerId) {
    try {
      return await getOrFetchCached(
        CACHE_TYPES.PLAYER,
        `landing_${playerId}`,
        () => fetchPlayerProfile(playerId),
      );
    } catch (error) {
      if (error?.status === 404 || error?.response?.status === 404) {
        throw createError(404, 'Player not found.');
      }
      throw createError(502, 'Could not look up that player.');
    }
  }

  /** Fetches the NHL schedule payload for the week starting at `date`. */
  async function fetchScheduleWeek(date) {
    const { data: schedulePayload } = await nhlApi.axiosNhl.get(
      `/schedule/${date}`,
    );
    return schedulePayload;
  }

  /**
   * `/schedule/{monday}` is assumed to return that 7-day `gameWeek`; if it
   * ends early, the week's Sunday is fetched too and merged.
   */
  async function getWeekSchedule(weekStart) {
    return await getOrFetchCached(
      CACHE_TYPES.SCHEDULE,
      `league_week_${weekStart}`,
      async () => {
        const startPayload = await fetchScheduleWeek(weekStart);
        const weekEnd = weekEndOf(weekStart);
        const days = startPayload?.gameWeek ?? [];
        if (days.some((day) => String(day?.date).slice(0, 10) >= weekEnd)) {
          return { gameWeek: days };
        }
        const endPayload = await fetchScheduleWeek(weekEnd);
        return { gameWeek: [...days, ...(endPayload?.gameWeek ?? [])] };
      },
    );
  }

  /** Every per-game stats row for one chunk of players in the week, across all pages. */
  async function fetchPlayerChunkGameRows(statsClient, playerIds, weekStart) {
    const filter = [
      `gameDate>="${weekStart}"`,
      `gameDate<="${weekEndOf(weekStart)} 23:59:59"`,
      'gameTypeId in (2,3)',
      `playerId in (${playerIds.join(',')})`,
    ].join(' and ');
    const sort = JSON.stringify([
      { property: 'gameDate', direction: 'ASC' },
      { property: 'playerId', direction: 'ASC' },
    ]);
    const gameRows = [];
    for (let page = 0; page < MAX_STATS_PAGES; page += 1) {
      const { data: pagePayload } = await statsClient.get(
        `/summary?isAggregate=false&isGame=true` +
          `&sort=${encodeURIComponent(sort)}` +
          `&start=${page * STATS_PAGE_SIZE}&limit=${STATS_PAGE_SIZE}` +
          `&cayenneExp=${encodeURIComponent(filter)}`,
      );
      const pageRows = pagePayload?.data;
      if (!Array.isArray(pageRows)) {
        throw new Error('NHL stats payload has no data array');
      }
      gameRows.push(...pageRows);
      const totalRows = Number(pagePayload?.total);
      const fetchedCount = (page + 1) * STATS_PAGE_SIZE;
      if (pageRows.length < STATS_PAGE_SIZE) break;
      if (Number.isFinite(totalRows) && fetchedCount >= totalRows) break;
    }
    return gameRows;
  }

  /** Every per-game row for `playerIds` in the week, fetched in chunks. */
  async function fetchGameRows(statsClient, playerIds, weekStart) {
    const gameRows = [];
    for (const playerIdChunk of chunk(playerIds, PLAYER_ID_CHUNK)) {
      gameRows.push(
        ...(await fetchPlayerChunkGameRows(
          statsClient,
          playerIdChunk,
          weekStart,
        )),
      );
    }
    return gameRows;
  }

  /** Cached, normalized game rows for the skaters or goalies (`kind`) in the week. */
  async function getGameRows(kind, statsClient, playerIds, weekStart) {
    if (playerIds.length === 0) return [];
    const cachedPayload = await getOrFetchCached(
      CACHE_TYPES.PLAYER,
      `weekly_${kind}_${weekStart}_${hashPlayerIds(playerIds)}`,
      async () => ({
        data: await fetchGameRows(statsClient, playerIds, weekStart),
      }),
    );
    return normalizeGameRows(cachedPayload?.data, { playerIds, weekStart });
  }

  /** Summarizes the league schedule for the week; any NHL failure becomes a 502. */
  async function loadWeekSchedule(weekStart) {
    try {
      return summarizeWeekSchedule(await getWeekSchedule(weekStart), weekStart);
    } catch (error) {
      console.error('Weekly report schedule failed:', error?.message);
      throw createError(502, 'NHL schedule unavailable.');
    }
  }

  /** Fetches the week's skater and goalie game rows together; any NHL failure becomes a 502. */
  async function loadWeekGameRows({ skaterIds, goalieIds, weekStart }) {
    try {
      const [skaterRows, goalieRows] = await Promise.all([
        getGameRows(
          'skaters',
          nhlApi.axiosNhlStats,
          sortIds(skaterIds),
          weekStart,
        ),
        getGameRows(
          'goalies',
          nhlApi.axiosNhlGoalie,
          sortIds(goalieIds),
          weekStart,
        ),
      ]);
      return { skaterRows, goalieRows };
    } catch (error) {
      console.error('Weekly report stats failed:', error?.message);
      throw createError(502, 'NHL stats unavailable.');
    }
  }

  /** Inserts the reports in one transaction; returns how many were new. */
  async function storeReports(reports, weekStart) {
    return await withTransaction(async (client) => {
      let createdCount = 0;
      for (const { userId, payload } of reports) {
        createdCount += await repository.insertReport(client, {
          userId,
          weekStart,
          payload,
        });
      }
      return createdCount;
    });
  }

  return {
    MAX_FAVORITE_PLAYERS,
    listFavorites,

    /** Favorites a player (409 past the cap) and returns the updated favorites. */
    async addFavorite(userId, playerId) {
      const parsedPlayerId = parsePlayerId(playerId);
      const profile = await getPlayerProfile(parsedPlayerId);
      const added = await withTransaction((client) =>
        repository.insertFavoritePlayer(client, {
          userId,
          playerId: parsedPlayerId,
          ...profile,
          limit: MAX_FAVORITE_PLAYERS,
        }),
      );
      if (!added) {
        throw createError(
          409,
          `You can favorite at most ${MAX_FAVORITE_PLAYERS} players.`,
        );
      }
      return { favorites: await listFavorites(userId) };
    },

    /** Sets a favorite player's tier and/or label and returns the updated favorites; 404 when not a favorite. */
    async updateCategory(userId, playerId, body) {
      const parsedPlayerId = parsePlayerId(playerId);
      const categoryChanges = parseCategoryUpdate(body);
      const updatedRowCount = await withTransaction((client) =>
        repository.updateFavoritePlayerCategory(client, {
          userId,
          playerId: parsedPlayerId,
          ...categoryChanges,
        }),
      );
      if (!updatedRowCount) throw createError(404, 'Player is not a favorite.');
      return { favorites: await listFavorites(userId) };
    },

    /** Removes a favorite player and returns the updated favorites. */
    async removeFavorite(userId, playerId) {
      const parsedPlayerId = parsePlayerId(playerId);
      await withTransaction((client) =>
        repository.deleteFavoritePlayer(client, {
          userId,
          playerId: parsedPlayerId,
        }),
      );
      return { favorites: await listFavorites(userId) };
    },

    /** The user's recent reports with the unread count. */
    async listReports(userId) {
      const reportRows = await withTransaction((client) =>
        repository.listReports(client, { userId, limit: MAX_REPORTS }),
      );
      const reports = reportRows.map(mapReportRow);
      return {
        reports,
        unreadCount: reports.filter((report) => !report.read).length,
      };
    },

    /** One report by week start; 404 when there is none. */
    async getReport(userId, weekStart) {
      const validWeekStart = requireWeekStart(weekStart);
      const reportRow = await withTransaction((client) =>
        repository.getReport(client, { userId, weekStart: validWeekStart }),
      );
      if (!reportRow) throw createError(404, 'No report for that week.');
      return mapReportRow(reportRow);
    },

    /** Marks the user's report for that week read. */
    async markRead(userId, weekStart) {
      const validWeekStart = requireWeekStart(weekStart);
      await withTransaction((client) =>
        repository.markReportRead(client, {
          userId,
          weekStart: validWeekStart,
        }),
      );
    },

    /** The week's stored reports, for pushing: `[{ userId, report, read }]`. */
    async listReportsForWeek(weekStart) {
      const reportRows = await withTransaction((client) =>
        repository.listReportsForWeek(client, weekStart),
      );
      return reportRows.map((reportRow) => ({
        userId: reportRow.user_id,
        report: reportRow.payload,
        read: Boolean(reportRow.read_at),
      }));
    },

    /**
     * Builds and stores every user's report for `weekStart`. Returns
     * `{ skipped: 'league-break' }` when no regular-season or playoff game was
     * completed that week. NHL failures throw 502 before anything is written.
     * Existing reports are kept as they are, so a rerun is harmless.
     */
    async generateWeek(weekStart) {
      const validWeekStart = requireWeekStart(weekStart);
      const schedule = await loadWeekSchedule(validWeekStart);
      if (schedule.leagueGames === 0) {
        return { skipped: 'league-break', created: 0 };
      }

      const favoriteRows = await withTransaction((client) =>
        repository.listAllFavoritePlayers(client),
      );
      const { favoritesByUser, skaterIds, goalieIds } =
        groupFavoritesByUser(favoriteRows);
      if (favoritesByUser.size === 0) return { created: 0 };

      const { skaterRows, goalieRows } = await loadWeekGameRows({
        skaterIds,
        goalieIds,
        weekStart: validWeekStart,
      });

      const reports = [];
      for (const [userId, favorites] of favoritesByUser) {
        const payload = buildWeeklyReport({
          weekStart: validWeekStart,
          favorites,
          skaterRows,
          goalieRows,
          schedule,
        });
        if (payload) reports.push({ userId, payload });
      }
      return { created: await storeReports(reports, validWeekStart) };
    },
  };
}

module.exports = { createWeeklyPlayerReportService, MAX_FAVORITE_PLAYERS };
