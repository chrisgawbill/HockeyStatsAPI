const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const teamsRepository = require('#slices/teams/teamRepository.js');
const scheduleGamesRepository = require('#slices/schedule/scheduleRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const {
  mapSchedulePayload,
} = require('#slices/schedule/mappers/scheduleDbMapper.js');
const { mapGame } = require('#slices/schedule/mappers/scheduleMapper.js');

/**
 * Upserts a season schedule into `schedule_games`.
 *
 * Accepts either the weekly schedule payload (`{ gameWeek: [...] }`) or the
 * club-schedule payload (`{ games: [...] }`).
 */
async function persistSchedule({
  seasonId,
  schedulePayload,
  sourceLabel = 'schedule',
}) {
  const mapped = mapSchedulePayload({ seasonId, schedulePayload });

  const teams = [];
  const games = [];
  for (const { homeTeam, awayTeam, game } of mapped.rows) {
    if (homeTeam) teams.push(homeTeam);
    if (awayTeam) teams.push(awayTeam);
    games.push(game);
  }

  return await withTransaction(async (client) => {
    // Season row first (FK parent), then teams before games
    // (schedule_games references teams). Batching dedupes the ~32 teams that
    // the payload repeats ~80x each, so teamsUpserted now counts unique teams.
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, { [sourceLabel]: schedulePayload ?? null }),
    );

    const teamsUpserted = await teamsRepository.upsertTeams(client, teams);
    const gamesUpserted = await scheduleGamesRepository.upsertScheduleGames(
      client,
      games,
    );

    return { gamesUpserted, teamsUpserted, skipped: mapped.skipped };
  });
}

/**
 * Flatten the raw weekly season payload into a list of ScheduleGameContract.
 * The week supplies date/dayAbbrev; each of its games is mapped with that ctx.
 * @param {{ gameWeek?: any[] }} raw
 * @returns {import("./mappers/scheduleMapper.js").ScheduleGameContract[]}
 */
function mapSeasonSchedule(raw) {
  const games = [];
  for (const week of raw?.gameWeek ?? []) {
    for (const g of week.games ?? []) {
      games.push(mapGame(g, { date: week.date, dayAbbrev: week.dayAbbrev }));
    }
  }
  return games;
}

/**
 * Local-time-aware short weekday for a YYYY-MM-DD club-schedule date.
 * (The club-schedule endpoint has no dayAbbrev like the weekly endpoint does.)
 * @param {string} gameDate
 * @returns {string}
 */
function shortDayOfWeek(gameDate) {
  return new Date(`${gameDate}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
  });
}

/**
 * Schedule slice service. Owns every read of NHL schedule data plus the
 * write-behind persistence of what it fetches; route handlers only pass through
 * the values it returns. Dependencies are supplied by the composition root.
 *
 * @param {{
 *   nhlApi: { axiosNhl: import('axios').AxiosInstance },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   seasons: typeof import('#platform/seasonHelper.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 * }} deps
 */
function createScheduleService({ nhlApi, cache, seasons, runServiceTask }) {
  const { axiosNhl } = nhlApi;
  const { GetOrFetch, writeCache, CACHE_TYPES } = cache;

  /**
   * Fetches a whole season's schedule from the NHL weekly endpoint. The NHL only
   * serves a week at a time, so this walks the season in 7-day steps and merges
   * every week's games into one raw `{ gameWeek }` payload (failed weeks are
   * skipped rather than failing the whole fetch). Always walks the full season
   * (September 1 of the start year through June 30 of the end year) regardless
   * of whether `seasonId` is the current season or a past one — the current
   * season's cache entry is kept fresh separately by the scheduled refresh
   * (see platform/refreshScheduler.js), not by narrowing this range, so
   * schedule/date logic elsewhere (SchedulePage's date paging, the
   * explicit-date-vs-today fallback, preseason games) can rely on the full
   * season actually being loaded.
   * @param {string} seasonId
   * @returns {Promise<{ gameWeek: any[] }>} Raw, unmapped weekly payloads combined.
   */
  async function fetchSeasonSchedule(seasonId) {
    const startYear = Number(seasonId.slice(0, 4));
    const startDate = new Date(`${startYear}-09-01`);
    const endDate = new Date(`${startYear + 1}-06-30`);

    const weekDates = [];
    const cur = new Date(startDate);
    while (cur <= endDate) {
      weekDates.push(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 7);
    }

    const responses = await Promise.all(
      weekDates.map((date) =>
        axiosNhl.get(`/schedule/${date}`).catch(() => null),
      ),
    );

    const allGameWeeks = [];
    for (const resp of responses) {
      if (resp?.data?.gameWeek) allGameWeeks.push(...resp.data.gameWeek);
    }
    return { gameWeek: allGameWeeks };
  }

  return {
    /**
     * Season schedule as `{ games }` of ScheduleGameContract, cached per season.
     * Persisting the raw payload is fire-and-forget so a DB hiccup cannot fail
     * the request.
     */
    async getSeasonSchedule(seasonId) {
      const raw = await GetOrFetch(CACHE_TYPES.SCHEDULE, seasonId, () =>
        fetchSeasonSchedule(seasonId),
      );
      runServiceTask(`season schedule ${seasonId}`, () =>
        persistSchedule({ seasonId, schedulePayload: raw }),
      );
      return { games: mapSeasonSchedule(raw) };
    },

    /** Raw gamecenter landing payload for one game (short TTL passthrough). */
    async getGameLanding(gameID) {
      return await GetOrFetch(
        CACHE_TYPES.SCHEDULE,
        `landing_${gameID}`,
        () => axiosNhl.get(`/gamecenter/${gameID}/landing`).then((r) => r.data),
        { ttlMs: 5 * 60 * 1000 },
      );
    },

    /** Raw gamecenter boxscore payload for one game (short TTL passthrough). */
    async getGameBoxscore(gameID) {
      return await GetOrFetch(
        CACHE_TYPES.SCHEDULE,
        `boxscore_${gameID}`,
        () =>
          axiosNhl.get(`/gamecenter/${gameID}/boxscore`).then((r) => r.data),
        { ttlMs: 5 * 60 * 1000 },
      );
    },

    /**
     * Re-fetches the current season's schedule and overwrites its cache entry.
     * Invoked on a timer by the refresh scheduler so the cached schedule stays
     * current without a user request triggering the fetch. Errors are logged,
     * not thrown, so a failed refresh never crashes the scheduler.
     */
    async refreshScheduleCache() {
      try {
        const seasonId = seasons.getCurrentSeasonId();
        const data = await fetchSeasonSchedule(seasonId);
        await writeCache(CACHE_TYPES.SCHEDULE, seasonId, data);
        console.log('Schedule cache refreshed at', new Date().toISOString());
      } catch (e) {
        console.error('Failed to refresh schedule cache:', e);
      }
    },

    /**
     * One club's season schedule, sorted by calendar date. Lives on the schedule
     * slice (not teams) because it maps and persists schedule data; the team
     * router simply composes both services.
     */
    async getTeamSchedule(triCode, seasonId) {
      const raw = await GetOrFetch(
        CACHE_TYPES.SCHEDULE,
        `team_${triCode}_${seasonId}`,
        () =>
          axiosNhl
            .get(`/club-schedule-season/${triCode}/${seasonId}`)
            .then((r) => r.data),
      );
      runServiceTask(`club schedule ${triCode} ${seasonId}`, () =>
        persistSchedule({
          seasonId,
          schedulePayload: raw,
          sourceLabel: 'clubSchedule',
        }),
      );
      const games = (raw.games ?? [])
        .map((g) =>
          mapGame(g, {
            date: g.gameDate,
            dayAbbrev: shortDayOfWeek(g.gameDate),
          }),
        )
        .sort(
          (a, b) =>
            new Date(`${a.date}T12:00:00`).getTime() -
            new Date(`${b.date}T12:00:00`).getTime(),
        );
      return { games };
    },

    persistSchedule,
  };
}

module.exports = {
  createScheduleService,
  persistSchedule,
};
