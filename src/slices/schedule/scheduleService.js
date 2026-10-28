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
const {
  applyNewestGameStatus,
  isOfficialFinal,
  readRawGameStatus,
} = require('#slices/schedule/mappers/gameStatusOverlay.js');

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
/** The live poll refreshes a started game's boxscore once it is this old. */
const POLL_TTL_MS = 60 * 1000;
/** The live poll stops on a game that started longer ago than this, OFF or not. */
const POLL_WINDOW_MS = 12 * 60 * 60 * 1000;
const FINAL_GAME_STATES = new Set(['FINAL', 'OFF']);

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
 * A club's display name and logo from its own season schedule, where every
 * game carries the club as home or away team. Falls back to the tri-code.
 */
function describeClubTeam(clubSchedulePayload, triCode) {
  for (const rawGame of clubSchedulePayload?.games ?? []) {
    const clubTeam = [rawGame.homeTeam, rawGame.awayTeam].find(
      (team) => team?.abbrev === triCode,
    );
    if (!clubTeam) continue;
    const placeName = clubTeam.placeName?.default ?? '';
    const commonName = clubTeam.commonName?.default ?? '';
    return {
      name: `${placeName} ${commonName}`.trim() || triCode,
      logo: clubTeam.logo ?? null,
    };
  }
  return { name: triCode, logo: null };
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
 *   playerStatsService?: { ingestOfficialGames(games: object[]): Promise<object> },
 * }} deps
 */
function createScheduleService({
  nhlApi,
  cache,
  seasons,
  runServiceTask,
  playerStatsService,
}) {
  const { axiosNhl } = nhlApi;
  const { getOrFetchCached, readCache, writeCache, CACHE_TYPES } = cache;

  /**
   * Raw gamecenter payload cached under `key`. An official (`OFF`) game never
   * changes again, so a cached copy of one is served forever; a game cached
   * while live refetches after `liveTtlMs`, anything else (preview,
   * unofficial FINAL) after `ttlMs`. All cases share one key, and the cache
   * upserts, so keeping finished games adds no rows.
   */
  async function getGamecenterPayload(
    key,
    nhlPath,
    { liveTtlMs = GAMECENTER_TTL_MS, ttlMs = GAMECENTER_TTL_MS } = {},
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
      { ttlMs: isLive ? liveTtlMs : ttlMs },
    );
  }

  /** Raw club season schedule, cached 12 hours per team and season; `options` go to the cache. */
  async function getClubSeasonPayload(triCode, seasonId, options = {}) {
    return await getOrFetchCached(
      CACHE_TYPES.SCHEDULE,
      `team_${triCode}_${seasonId}`,
      () =>
        axiosNhl
          .get(`/club-schedule-season/${triCode}/${seasonId}`)
          .then((response) => response.data),
      options,
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

  /** A cached schedule-type payload at any age, without fetching; null when absent. */
  function readStoredPayload(key) {
    return readCache(CACHE_TYPES.SCHEDULE, key, { ttlMs: Infinity });
  }

  /**
   * Statuses of every game in the cached current-week club schedules of the
   * teams playing `games`, keyed by game id (10-minute cache).
   */
  async function readClubWeekStatuses(games) {
    const triCodes = [
      ...new Set(games.flatMap((game) => [game.homeTeam, game.awayTeam])),
    ].filter(Boolean);
    const weekPayloads = await Promise.all(
      triCodes.map((triCode) => readStoredPayload(`team_${triCode}_week_now`)),
    );

    const statusesByGameId = new Map();
    for (const weekPayload of weekPayloads) {
      for (const rawGame of weekPayload?.games ?? []) {
        const status = readRawGameStatus(rawGame);
        if (!status) continue;
        const gameStatuses = statusesByGameId.get(rawGame.id) ?? [];
        statusesByGameId.set(rawGame.id, [...gameStatuses, status]);
      }
    }
    return statusesByGameId;
  }

  /**
   * Brings each started, not yet official game in a season schedule up to the
   * newest status already in the cache: its boxscore and landing payloads and
   * its teams' current weeks. The season schedule itself is cached for hours,
   * so without this a game that the game page already shows live or final
   * stays FUT or LIVE on the schedule. Reads the cache only; never calls the
   * NHL.
   */
  async function applyStoredGameStatuses(games) {
    const now = Date.now();
    const startedGames = games.filter(
      (game) =>
        !isOfficialFinal(game.gameState) && Date.parse(game.gameTime) <= now,
    );
    if (startedGames.length === 0) return games;

    const clubWeekStatuses = await readClubWeekStatuses(startedGames);
    const updatedGames = await Promise.all(
      startedGames.map(async (game) => {
        const [boxscorePayload, landingPayload] = await Promise.all([
          readStoredPayload(`boxscore_${game.gameId}`),
          readStoredPayload(`landing_${game.gameId}`),
        ]);
        return applyNewestGameStatus(game, [
          readRawGameStatus(boxscorePayload),
          readRawGameStatus(landingPayload),
          ...(clubWeekStatuses.get(game.gameId) ?? []),
        ]);
      }),
    );

    const updatedGamesById = new Map(
      updatedGames.map((game) => [game.gameId, game]),
    );
    return games.map((game) => updatedGamesById.get(game.gameId) ?? game);
  }

  /** Raw season schedule from the NHL weekly endpoint, cached per season. */
  async function getSeasonPayload(seasonId) {
    return await getOrFetchCached(CACHE_TYPES.SCHEDULE, seasonId, () =>
      fetchSeasonSchedule(seasonId),
    );
  }

  /**
   * Started games in the current season schedule that are not yet official
   * (`OFF`) per that schedule and started within POLL_WINDOW_MS. One whose
   * cached boxscore is already official costs a cache read, no NHL call.
   */
  async function listGamesToPoll(now) {
    const games = mapSeasonSchedule(
      await getSeasonPayload(seasons.getCurrentSeasonId()),
    );
    return games.filter((game) => {
      const startMs = Date.parse(game.gameTime);
      return (
        !isOfficialFinal(game.gameState) &&
        startMs <= now &&
        now - startMs <= POLL_WINDOW_MS
      );
    });
  }

  return {
    /**
     * Season schedule as `{ games }` of ScheduleGameContract, cached per season,
     * with started games brought up to the newest status in the cache.
     * Persisting the raw payload is fire-and-forget so a DB hiccup cannot fail
     * the request.
     */
    async getSeasonSchedule(seasonId) {
      const schedulePayload = await getSeasonPayload(seasonId);
      runServiceTask(`season schedule ${seasonId}`, () =>
        persistSchedule({ seasonId, schedulePayload }),
      );
      return {
        games: await applyStoredGameStatuses(
          mapSeasonSchedule(schedulePayload),
        ),
      };
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
      const clubSchedulePayload = await getClubSeasonPayload(
        triCode,
        seasonId,
      );
      runServiceTask(`club schedule ${triCode} ${seasonId}`, () =>
        persistSchedule({
          seasonId,
          schedulePayload: clubSchedulePayload,
          sourceLabel: 'clubSchedule',
        }),
      );
      return {
        games: await applyStoredGameStatuses(mapClubGames(clubSchedulePayload)),
      };
    },

    /**
     * One club's season games with its display name and logo, from the same
     * 12-hour cache as `getTeamSchedule`. `{ fresh: true }` waits for a
     * refetch instead of serving the cached copy (falling back to it if the
     * NHL call fails), for when the cached copy is missing a recent final.
     */
    async getClubSeason(triCode, seasonId, { fresh = false } = {}) {
      const clubSchedulePayload = await getClubSeasonPayload(
        triCode,
        seasonId,
        fresh ? { ttlMs: 0 } : {},
      );
      return {
        team: describeClubTeam(clubSchedulePayload, triCode),
        games: mapClubGames(clubSchedulePayload),
      };
    },

    /**
     * One club's games for the current NHL week, on a short TTL. The season
     * club schedule above is cached for 12 hours, which is too stale to notice
     * a game that just went final; After Action Reports overlay this on top.
     */
    async getRecentTeamGames(triCode) {
      const weekPayload = await getOrFetchCached(
        CACHE_TYPES.SCHEDULE,
        `team_${triCode}_week_now`,
        () =>
          axiosNhl
            .get(`/club-schedule/${triCode}/week/now`)
            .then((response) => response.data),
        { ttlMs: RECENT_TEAM_GAMES_TTL_MS },
      );
      return { games: await applyStoredGameStatuses(mapClubGames(weekPayload)) };
    },

    /**
     * League-wide live poll: refreshes the boxscore of every game in the
     * current season schedule that has started and is not official yet
     * (at most once a minute per game, shared with the game page's cache),
     * then writes each game's state and score to `schedule_games`. Every
     * schedule read overlays these boxscores, so After Action Reports and
     * pushes see a final without polling each user's teams. Games that are
     * official (`OFF`) have their teams' player stats refreshed in the
     * database. Runs from the notifier's schedule and at the start of each
     * push dispatch. A failed game is counted and retried on the next poll.
     */
    async pollGames() {
      const now = Date.now();
      const games = await listGamesToPoll(now);
      const outcomes = await Promise.allSettled(
        games.map((game) =>
          getGamecenterPayload(
            `boxscore_${game.gameId}`,
            `/gamecenter/${game.gameId}/boxscore`,
            { liveTtlMs: POLL_TTL_MS, ttlMs: POLL_TTL_MS },
          ),
        ),
      );

      const statuses = [];
      const officialGames = [];
      const summary = { polled: games.length, live: 0, final: 0, failed: 0 };
      outcomes.forEach((outcome, index) => {
        const status =
          outcome.status === 'fulfilled'
            ? readRawGameStatus(outcome.value)
            : null;
        if (!status) {
          summary.failed += 1;
          console.error(
            `Live poll ${games[index].gameId} failed:`,
            outcome.reason?.message ?? 'no game state',
          );
          return;
        }
        if (LIVE_GAME_STATES.has(status.gameState)) summary.live += 1;
        if (FINAL_GAME_STATES.has(status.gameState)) summary.final += 1;
        statuses.push({
          gameId: games[index].gameId,
          gameState: status.gameState,
          homeScore: status.homeScore,
          awayScore: status.awayScore,
          periodDescriptor: outcome.value.periodDescriptor ?? null,
        });
        if (isOfficialFinal(status.gameState)) {
          officialGames.push({
            gameId: games[index].gameId,
            seasonId: String(
              outcome.value.season ?? seasons.getCurrentSeasonId(),
            ),
            gameType: outcome.value.gameType,
            teamIds: [outcome.value.homeTeam?.id, outcome.value.awayTeam?.id]
              .filter(Boolean),
          });
        }
      });

      runServiceTask('live game statuses', () =>
        withTransaction((client) =>
          scheduleGamesRepository.updateGameStatuses(client, statuses),
        ),
      );
      if (playerStatsService && officialGames.length > 0) {
        runServiceTask('team stats after official games', () =>
          playerStatsService.ingestOfficialGames(officialGames),
        );
      }
      return summary;
    },

    persistSchedule,
  };
}

module.exports = {
  createScheduleService,
  persistSchedule,
};
