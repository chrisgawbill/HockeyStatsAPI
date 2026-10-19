const crypto = require('crypto');
const createError = require('http-errors');
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

function normalizePlayerId(playerId) {
  const normalized = Number(playerId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw createError(400, 'Invalid player id.');
  }
  return normalized;
}

function normalizeWeekStart(weekStart) {
  if (!isWeekStart(weekStart)) {
    throw createError(400, 'weekStart must be a Monday (YYYY-MM-DD).');
  }
  return weekStart;
}

function toFavorite(row) {
  return {
    playerId: Number(row.player_id),
    name: row.full_name,
    teamTriCode: row.team_tri_code ?? null,
    position: row.position ?? null,
    headshot: row.headshot ?? null,
    since: new Date(row.created_at).toISOString(),
  };
}

function toReport(row) {
  return {
    ...row.payload,
    weekStart: row.week_start,
    createdAt: new Date(row.created_at).toISOString(),
    read: Boolean(row.read_at),
  };
}

function idsKey(ids) {
  return crypto
    .createHash('sha1')
    .update(ids.join(','))
    .digest('hex')
    .slice(0, 16);
}

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
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
  const { GetOrFetch, CACHE_TYPES } = cache;

  async function listFavorites(userId) {
    const rows = await withTransaction((client) =>
      repository.listFavoritePlayers(client, userId),
    );
    return rows.map(toFavorite);
  }

  /** Name/team/position for display, from the NHL player landing (24h cache). */
  async function getPlayerProfile(playerId) {
    try {
      return await GetOrFetch(
        CACHE_TYPES.PLAYER,
        `landing_${playerId}`,
        async () => {
          const res = await nhlApi.axiosNhl.get(`/player/${playerId}/landing`);
          const data = res.data ?? {};
          const first = data.firstName?.default ?? data.firstName ?? '';
          const last = data.lastName?.default ?? data.lastName ?? '';
          const fullName = `${first} ${last}`.trim();
          if (!fullName) throw createError(404, 'Player not found.');
          return {
            fullName,
            teamTriCode: data.currentTeamAbbrev ?? null,
            position: data.position ?? null,
            headshot: data.headshot ?? null,
          };
        },
      );
    } catch (error) {
      if (error?.status === 404 || error?.response?.status === 404) {
        throw createError(404, 'Player not found.');
      }
      throw createError(502, 'Could not look up that player.');
    }
  }

  async function fetchScheduleWeek(date) {
    const res = await nhlApi.axiosNhl.get(`/schedule/${date}`);
    return res.data;
  }

  /**
   * `/schedule/{monday}` is assumed to return that 7-day `gameWeek`; if it
   * ends early, the week's Sunday is fetched too and merged.
   */
  async function getWeekSchedule(weekStart) {
    return await GetOrFetch(
      CACHE_TYPES.SCHEDULE,
      `league_week_${weekStart}`,
      async () => {
        const first = await fetchScheduleWeek(weekStart);
        const weekEnd = weekEndOf(weekStart);
        const days = first?.gameWeek ?? [];
        if (days.some((day) => String(day?.date).slice(0, 10) >= weekEnd)) {
          return { gameWeek: days };
        }
        const second = await fetchScheduleWeek(weekEnd);
        return { gameWeek: [...days, ...(second?.gameWeek ?? [])] };
      },
    );
  }

  /** Every per-game row for `playerIds` in the week, across all pages. */
  async function fetchGameRows(client, playerIds, weekStart) {
    const rows = [];
    for (const ids of chunk(playerIds, PLAYER_ID_CHUNK)) {
      const cayenneExp = [
        `gameDate>="${weekStart}"`,
        `gameDate<="${weekEndOf(weekStart)} 23:59:59"`,
        'gameTypeId in (2,3)',
        `playerId in (${ids.join(',')})`,
      ].join(' and ');
      const sort = JSON.stringify([
        { property: 'gameDate', direction: 'ASC' },
        { property: 'playerId', direction: 'ASC' },
      ]);
      for (let page = 0; page < MAX_STATS_PAGES; page += 1) {
        const res = await client.get(
          `/summary?isAggregate=false&isGame=true` +
            `&sort=${encodeURIComponent(sort)}` +
            `&start=${page * STATS_PAGE_SIZE}&limit=${STATS_PAGE_SIZE}` +
            `&cayenneExp=${encodeURIComponent(cayenneExp)}`,
        );
        const data = res.data?.data;
        if (!Array.isArray(data)) {
          throw new Error('NHL stats payload has no data array');
        }
        rows.push(...data);
        const total = Number(res.data?.total);
        const fetched = (page + 1) * STATS_PAGE_SIZE;
        if (data.length < STATS_PAGE_SIZE) break;
        if (Number.isFinite(total) && fetched >= total) break;
      }
    }
    return rows;
  }

  async function getGameRows(kind, client, playerIds, weekStart) {
    if (playerIds.length === 0) return [];
    const payload = await GetOrFetch(
      CACHE_TYPES.PLAYER,
      `weekly_${kind}_${weekStart}_${idsKey(playerIds)}`,
      async () => ({
        data: await fetchGameRows(client, playerIds, weekStart),
      }),
    );
    return normalizeGameRows(payload?.data, { playerIds, weekStart });
  }

  return {
    MAX_FAVORITE_PLAYERS,
    listFavorites,

    async addFavorite(userId, playerId) {
      const normalized = normalizePlayerId(playerId);
      const profile = await getPlayerProfile(normalized);
      const added = await withTransaction((client) =>
        repository.insertFavoritePlayer(client, {
          userId,
          playerId: normalized,
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

    async removeFavorite(userId, playerId) {
      const normalized = normalizePlayerId(playerId);
      await withTransaction((client) =>
        repository.deleteFavoritePlayer(client, {
          userId,
          playerId: normalized,
        }),
      );
      return { favorites: await listFavorites(userId) };
    },

    async listReports(userId) {
      const rows = await withTransaction((client) =>
        repository.listReports(client, { userId, limit: MAX_REPORTS }),
      );
      const reports = rows.map(toReport);
      return {
        reports,
        unreadCount: reports.filter((report) => !report.read).length,
      };
    },

    async getReport(userId, weekStart) {
      const normalized = normalizeWeekStart(weekStart);
      const row = await withTransaction((client) =>
        repository.getReport(client, { userId, weekStart: normalized }),
      );
      if (!row) throw createError(404, 'No report for that week.');
      return toReport(row);
    },

    async markRead(userId, weekStart) {
      const normalized = normalizeWeekStart(weekStart);
      await withTransaction((client) =>
        repository.markReportRead(client, { userId, weekStart: normalized }),
      );
    },

    /** The week's stored reports, for pushing: `[{ userId, report, read }]`. */
    async listReportsForWeek(weekStart) {
      const rows = await withTransaction((client) =>
        repository.listReportsForWeek(client, weekStart),
      );
      return rows.map((row) => ({
        userId: row.user_id,
        report: row.payload,
        read: Boolean(row.read_at),
      }));
    },

    /**
     * Builds and stores every user's report for `weekStart`. Returns
     * `{ skipped: 'league-break' }` when no regular-season or playoff game was
     * completed that week. NHL failures throw 502 before anything is written.
     * Existing reports are kept as they are, so a rerun is harmless.
     */
    async generateWeek(weekStart) {
      const normalized = normalizeWeekStart(weekStart);
      let schedule;
      try {
        schedule = summarizeWeekSchedule(
          await getWeekSchedule(normalized),
          normalized,
        );
      } catch (error) {
        console.error('Weekly report schedule failed:', error?.message);
        throw createError(502, 'NHL schedule unavailable.');
      }
      if (schedule.leagueGames === 0) {
        return { skipped: 'league-break', created: 0 };
      }

      const rows = await withTransaction((client) =>
        repository.listAllFavoritePlayers(client),
      );
      const favoritesByUser = new Map();
      const skaterIds = new Set();
      const goalieIds = new Set();
      for (const row of rows) {
        const favorite = toFavorite(row);
        const list = favoritesByUser.get(row.user_id) ?? [];
        list.push(favorite);
        favoritesByUser.set(row.user_id, list);
        (favorite.position === 'G' ? goalieIds : skaterIds).add(
          favorite.playerId,
        );
      }
      if (favoritesByUser.size === 0) return { created: 0 };

      let skaterRows;
      let goalieRows;
      try {
        const byId = (a, b) => a - b;
        [skaterRows, goalieRows] = await Promise.all([
          getGameRows(
            'skaters',
            nhlApi.axiosNhlStats,
            [...skaterIds].sort(byId),
            normalized,
          ),
          getGameRows(
            'goalies',
            nhlApi.axiosNhlGoalie,
            [...goalieIds].sort(byId),
            normalized,
          ),
        ]);
      } catch (error) {
        console.error('Weekly report stats failed:', error?.message);
        throw createError(502, 'NHL stats unavailable.');
      }

      const reports = [];
      for (const [userId, favorites] of favoritesByUser) {
        const payload = buildWeeklyReport({
          weekStart: normalized,
          favorites,
          skaterRows,
          goalieRows,
          schedule,
        });
        if (payload) reports.push({ userId, payload });
      }
      const created = await withTransaction(async (client) => {
        let count = 0;
        for (const { userId, payload } of reports) {
          count += await repository.insertReport(client, {
            userId,
            weekStart: normalized,
            payload,
          });
        }
        return count;
      });
      return { created };
    },
  };
}

module.exports = { createWeeklyPlayerReportService, MAX_FAVORITE_PLAYERS };
