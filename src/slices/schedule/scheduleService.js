const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const teamsRepository = require('#slices/teams/teamRepository.js');
const scheduleGamesRepository = require('#slices/schedule/scheduleRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const {
  mapSchedulePayload,
} = require('#slices/schedule/mappers/scheduleDbMapper.js');
const { mapGame } = require('#slices/schedule/mappers/scheduleMapper.js');
const {
  mapPlayByPlay,
} = require('#slices/schedule/mappers/playByPlayMapper.js');

/**
 * Upserts a season schedule into `schedule_games`.
 *
 * Accepts either the weekly schedule payload (`{ gameWeek: [...] }`) or the
 * club-schedule payload (`{ games: [...] }`). The season row goes first (FK
 * parent), then teams, then games, which reference teams. Batching dedupes the
 * ~32 teams the payload repeats ~80x each, so `teamsUpserted` counts unique teams.
 */
async function persistSchedule({
  seasonId,
  schedulePayload,
  sourceLabel = 'schedule',
}) {
  const mappedSchedule = mapSchedulePayload({ seasonId, schedulePayload });

  const teams = [];
  const games = [];
  for (const { homeTeam, awayTeam, game } of mappedSchedule.rows) {
    if (homeTeam) teams.push(homeTeam);
    if (awayTeam) teams.push(awayTeam);
    games.push(game);
  }

  return await withTransaction(async (client) => {
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, { [sourceLabel]: schedulePayload ?? null }),
    );

    const teamsUpserted = await teamsRepository.upsertTeams(client, teams);
    const gamesUpserted = await scheduleGamesRepository.upsertScheduleGames(
      client,
      games,
    );

    return { gamesUpserted, teamsUpserted, skipped: mappedSchedule.skipped };
  });
}

/**
 * Flatten the raw weekly season payload into a list of ScheduleGameContract.
 * The week supplies date/dayAbbrev; each of its games is mapped with that ctx.
 * @param {{ gameWeek?: any[] }} weeklyPayload
 * @returns {import("./mappers/scheduleMapper.js").ScheduleGameContract[]}
 */
function mapSeasonSchedule(weeklyPayload) {
  const games = [];
  for (const week of weeklyPayload?.gameWeek ?? []) {
    for (const rawGame of week.games ?? []) {
      games.push(
        mapGame(rawGame, { date: week.date, dayAbbrev: week.dayAbbrev }),
      );
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

const RECENT_TEAM_GAMES_TTL_MS = 10 * 60 * 1000;
const GAMECENTER_TTL_MS = 5 * 60 * 1000;
const LIVE_PLAY_BY_PLAY_TTL_MS = 60 * 1000;
const LIVE_GAME_STATES = new Set(['LIVE', 'CRIT']);

/**
 * Maps a raw club-schedule payload (season or week) to ScheduleGameContracts
 * sorted by calendar date. Club schedules carry the date on each game.
 */
function mapClubGames(clubSchedulePayload) {
  return (clubSchedulePayload?.games ?? [])
    .map((rawGame) =>
      mapGame(rawGame, {
        date: rawGame.gameDate,
        dayAbbrev: shortDayOfWeek(rawGame.gameDate),
      }),
    )
    .sort(
      (earlierGame, laterGame) =>
        new Date(`${earlierGame.date}T12:00:00`).getTime() -
        new Date(`${laterGame.date}T12:00:00`).getTime(),
    );
}

/**
 * Lists the weekly-endpoint start dates (YYYY-MM-DD, 7 days apart) that cover a
 * season, from September 1 of its start year through June 30 of its end year.
 */
function listSeasonWeekDates(seasonId) {
  const startYear = Number(seasonId.slice(0, 4));
  const seasonEnd = new Date(`${startYear + 1}-06-30`);

  const weekDates = [];
  const weekStart = new Date(`${startYear}-09-01`);
  while (weekStart <= seasonEnd) {
    weekDates.push(weekStart.toISOString().split('T')[0]);
    weekStart.setDate(weekStart.getDate() + 7);
  }
  return weekDates;
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
  const { getOrFetchCached, readCache, writeCache, CACHE_TYPES } = cache;

  /**
   * Raw gamecenter payload cached under `key`. An official (`OFF`) game never
   * changes again, so a cached copy of one is served forever; a game cached
   * while live refetches after `liveTtlMs`, anything else (preview,
   * unofficial FINAL) after GAMECENTER_TTL_MS. All cases share one key, and
   * the cache upserts, so keeping finished games adds no rows.
   */
  async function getGamecenterPayload(
    key,
    nhlPath,
    { liveTtlMs = GAMECENTER_TTL_MS } = {},
  ) {
    const cachedPayload = await readCache(CACHE_TYPES.SCHEDULE, key, {
      ttlMs: Infinity,
    });
    if (cachedPayload?.gameState === 'OFF') return cachedPayload;
    const isLive = LIVE_GAME_STATES.has(cachedPayload?.gameState);
    return await getOrFetchCached(
      CACHE_TYPES.SCHEDULE,
      key,
      () => axiosNhl.get(nhlPath).then((response) => response.data),
      { ttlMs: isLive ? liveTtlMs : GAMECENTER_TTL_MS },
    );
  }

  /**
   * Fetches a whole season's schedule from the NHL weekly endpoint. The NHL only
   * serves a week at a time, so this walks the season in 7-day steps and merges
   * every week's games into one raw `{ gameWeek }` payload (failed weeks are
   * skipped rather than failing the whole fetch). Always walks the full season
   * regardless of whether `seasonId` is the current season or a past one — the current
   * season's cache entry is kept fresh separately by the scheduled refresh
   * (see platform/refreshScheduler.js), not by narrowing this range, so
   * schedule/date logic elsewhere (SchedulePage's date paging, the
   * explicit-date-vs-today fallback, preseason games) can rely on the full
   * season actually being loaded.
   * @param {string} seasonId
   * @returns {Promise<{ gameWeek: any[] }>} Raw, unmapped weekly payloads combined.
   */
  async function fetchSeasonSchedule(seasonId) {
    const responses = await Promise.all(
      listSeasonWeekDates(seasonId).map((date) =>
        axiosNhl.get(`/schedule/${date}`).catch(() => null),
      ),
    );

    const allGameWeeks = [];
    for (const response of responses) {
      if (response?.data?.gameWeek) {
        allGameWeeks.push(...response.data.gameWeek);
      }
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
      const schedulePayload = await getOrFetchCached(
        CACHE_TYPES.SCHEDULE,
        seasonId,
        () => fetchSeasonSchedule(seasonId),
      );
      runServiceTask(`season schedule ${seasonId}`, () =>
        persistSchedule({ seasonId, schedulePayload }),
      );
      return { games: mapSeasonSchedule(schedulePayload) };
    },

    /** Raw gamecenter landing payload for one game (permanent once OFF). */
    async getGameLanding(gameID) {
      return await getGamecenterPayload(`landing_${gameID}`, `/gamecenter/${gameID}/landing`);
    },

    /** Raw gamecenter boxscore payload for one game (permanent once OFF). */
    async getGameBoxscore(gameID) {
      return await getGamecenterPayload(`boxscore_${gameID}`, `/gamecenter/${gameID}/boxscore`);
    },

    /**
     * A game's shots and goals as a PlayByPlayContract. The raw NHL payload is
     * what gets cached (permanent once OFF, 1 minute while live, otherwise 5
     * minutes); mapping runs on every read.
     */
    async getGamePlayByPlay(gameID) {
      const playByPlayPayload = await getGamecenterPayload(
        `playbyplay_${gameID}`,
        `/gamecenter/${gameID}/play-by-play`,
        { liveTtlMs: LIVE_PLAY_BY_PLAY_TTL_MS },
      );
      return mapPlayByPlay(playByPlayPayload);
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
        const schedulePayload = await fetchSeasonSchedule(seasonId);
        await writeCache(CACHE_TYPES.SCHEDULE, seasonId, schedulePayload);
        console.log('Schedule cache refreshed at', new Date().toISOString());
      } catch (error) {
        console.error('Failed to refresh schedule cache:', error);
      }
    },

    /**
     * One club's season schedule, sorted by calendar date. Lives on the schedule
     * slice (not teams) because it maps and persists schedule data; the team
     * router simply composes both services.
     */
    async getTeamSchedule(triCode, seasonId) {
      const clubSchedulePayload = await getOrFetchCached(
        CACHE_TYPES.SCHEDULE,
        `team_${triCode}_${seasonId}`,
        () =>
          axiosNhl
            .get(`/club-schedule-season/${triCode}/${seasonId}`)
            .then((response) => response.data),
      );
      runServiceTask(`club schedule ${triCode} ${seasonId}`, () =>
        persistSchedule({
          seasonId,
          schedulePayload: clubSchedulePayload,
          sourceLabel: 'clubSchedule',
        }),
      );
      return { games: mapClubGames(clubSchedulePayload) };
    },

    /**
     * One club's games for the current NHL week, on a short TTL. The season
     * club schedule above is cached for 12 hours, which is too stale to notice
     * a game that just went final; After Action Reports overlay this on top.
     * `{ fresh: true }` skips the cache read (push dispatch) but still refills it.
     */
    async getRecentTeamGames(triCode, { fresh = false } = {}) {
      const weekPayload = await getOrFetchCached(
        CACHE_TYPES.SCHEDULE,
        `team_${triCode}_week_now`,
        () =>
          axiosNhl
            .get(`/club-schedule/${triCode}/week/now`)
            .then((response) => response.data),
        { ttlMs: fresh ? 0 : RECENT_TEAM_GAMES_TTL_MS },
      );
      return { games: mapClubGames(weekPayload) };
    },

    persistSchedule,
  };
}

module.exports = {
  createScheduleService,
  persistSchedule,
};
