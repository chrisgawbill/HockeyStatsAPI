const {
  mapSkaterSummary,
  mapGoalieSummary,
} = require('#slices/players/mappers/playerMapper.js');
const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const playersRepository = require('#slices/players/playersRepository.js');
const playerStatsRepository = require('#slices/players/playerStatsRepository.js');
const teamStatReportRepository = require('#slices/players/teamStatReportRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const { fetchAllStatsRows } = require('#platform/nhlStatsPages.js');
const {
  mapPlayerStatsPayload,
} = require('#slices/players/mappers/playerStatsDbMapper.js');

/** Summary sort: best first, then player id so pages never overlap or skip. */
const SKATER_SUMMARY_SORT = [
  { property: 'points', direction: 'DESC' },
  { property: 'playerId', direction: 'ASC' },
];
const GOALIE_SUMMARY_SORT = [
  { property: 'wins', direction: 'DESC' },
  { property: 'playerId', direction: 'ASC' },
];

/** Stored team stat reports; each is the raw NHL payload of one stats endpoint. */
const TEAM_REPORTS = {
  SKATER_SUMMARY: 'skater_summary',
  SKATER_CORSI: 'skater_corsi',
  SKATER_FACEOFFS: 'skater_faceoffs',
  GOALIE_SUMMARY: 'goalie_summary',
};

/** NHL game type of regular-season games, the only ones the reports count. */
const REGULAR_SEASON_GAME_TYPE = 2;

/**
 * Upserts a season's player stats (and the players they belong to) in one
 * transaction: the season row first (FK parent), then players before stats
 * (player_season_stats references players).
 */
async function persistPlayerStats({
  seasonId,
  playerType,
  statsPayload,
  teamId = null,
  teamScope = teamId ? String(teamId) : 'all',
}) {
  const mappedStats = mapPlayerStatsPayload({
    seasonId,
    playerType,
    statsPayload,
    teamId,
    teamScope,
  });

  return await withTransaction(async (client) => {
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, { [`${playerType}Stats`]: statsPayload ?? null }),
    );

    const playersUpserted = await playersRepository.upsertPlayers(
      client,
      mappedStats.rows.map((mappedRow) => mappedRow.player),
    );
    const statsUpserted = await playerStatsRepository.upsertPlayerSeasonStats(
      client,
      mappedStats.rows.map((mappedRow) => mappedRow.stats),
    );

    return { playersUpserted, statsUpserted, skipped: mappedStats.skipped };
  });
}

/**
 * Players slice service: regular-season skater/goalie stat reads for a team
 * (or the whole league) plus write-behind persistence.
 *
 * Team-scoped reports are served from `team_player_stat_reports`, refreshed
 * for both teams when a game goes official (`ingestOfficialGames`), so the
 * team page shows a finished game's stats without calling the NHL. A report
 * missing from the database is fetched once and stored. League-wide reads
 * stay on the cache.
 *
 * @param {{
 *   nhlApi: {
 *     axiosNhlStats: import('axios').AxiosInstance,
 *     axiosNhlGoalie: import('axios').AxiosInstance,
 *   },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 * }} deps
 */
function createPlayerStatsService({
  nhlApi,
  cache,
  runServiceTask,
  withTransaction: runInTransaction = withTransaction,
}) {
  const { axiosNhlStats, axiosNhlGoalie } = nhlApi;
  const { getOrFetchCached, CACHE_TYPES } = cache;

  /** NHL stats API filter for one season, optionally narrowed to one team. */
  function buildCayenneFilter(seasonId, teamId) {
    let filter = `seasonId=${seasonId} and gameTypeId=2`;
    if (teamId) filter += ` and teamId=${teamId}`;
    return encodeURIComponent(filter);
  }

  /**
   * Fetches every summary row for a season (optionally one team) across all
   * pages, and queues the rows for the database. Persisting here, on a fresh
   * fetch only, keeps cache hits from re-writing the whole league each time.
   */
  async function fetchSummaryPayload({
    playerType,
    statsClient,
    sort,
    seasonId,
    teamId,
  }) {
    const sortParam = encodeURIComponent(JSON.stringify(sort));
    const statsPayload = await fetchAllStatsRows((start, limit) =>
      statsClient
        .get(
          `/summary?cayenneExp=${buildCayenneFilter(seasonId, teamId)}` +
            `&sort=${sortParam}&start=${start}&limit=${limit}`,
        )
        .then((response) => response.data),
    );
    runServiceTask(`${playerType} summary ${teamId || 'all'} ${seasonId}`, () =>
      persistPlayerStats({
        seasonId,
        playerType,
        statsPayload,
        teamId: teamId ? Number(teamId) : null,
      }),
    );
    return statsPayload;
  }

  /** NHL fetchers for each report, by season and optional team. */
  const REPORT_FETCHERS = {
    [TEAM_REPORTS.SKATER_SUMMARY]: (seasonId, teamId) =>
      fetchSummaryPayload({
        playerType: 'skater',
        statsClient: axiosNhlStats,
        sort: SKATER_SUMMARY_SORT,
        seasonId,
        teamId,
      }),
    [TEAM_REPORTS.SKATER_CORSI]: (seasonId, teamId) =>
      axiosNhlStats
        .get(
          `/percentages?cayenneExp=${buildCayenneFilter(seasonId, teamId)}&limit=100`,
        )
        .then((response) => response.data),
    [TEAM_REPORTS.SKATER_FACEOFFS]: (seasonId, teamId) =>
      axiosNhlStats
        .get(
          `/faceoffpercentages?cayenneExp=${buildCayenneFilter(seasonId, teamId)}&limit=100`,
        )
        .then((response) => response.data),
    [TEAM_REPORTS.GOALIE_SUMMARY]: (seasonId, teamId) =>
      fetchSummaryPayload({
        playerType: 'goalie',
        statsClient: axiosNhlGoalie,
        sort: GOALIE_SUMMARY_SORT,
        seasonId,
        teamId,
      }),
  };

  /**
   * League-wide reports, cached. League-wide summaries hold every player
   * (paged), so they use their own key and never return an older 100-row entry.
   */
  const LEAGUE_CACHE_KEYS = {
    [TEAM_REPORTS.SKATER_SUMMARY]: (seasonId) =>
      `skater_summary_league_${seasonId}`,
    [TEAM_REPORTS.SKATER_CORSI]: (seasonId) => `skater_corsi_all_${seasonId}`,
    [TEAM_REPORTS.SKATER_FACEOFFS]: (seasonId) =>
      `skater_faceoffs_all_${seasonId}`,
    [TEAM_REPORTS.GOALIE_SUMMARY]: (seasonId) =>
      `goalie_summary_league_${seasonId}`,
  };

  /**
   * A team's report from the database; fetched from the NHL and stored when
   * missing. If the database cannot be read, the NHL payload is served unstored.
   */
  async function readTeamReport(report, teamId, seasonId) {
    const numericTeamId = Number(teamId);
    let storedPayload;
    try {
      storedPayload = await runInTransaction((client) =>
        teamStatReportRepository.getTeamStatReport(
          client,
          seasonId,
          numericTeamId,
          report,
        ),
      );
    } catch (error) {
      console.error(
        `Failed to read ${report} ${teamId} ${seasonId}:`,
        error.message,
      );
      return await REPORT_FETCHERS[report](seasonId, teamId);
    }
    if (storedPayload) return storedPayload;

    const payload = await REPORT_FETCHERS[report](seasonId, teamId);
    runServiceTask(`store ${report} ${teamId} ${seasonId}`, () =>
      runInTransaction((client) =>
        teamStatReportRepository.upsertTeamStatReport(
          client,
          seasonId,
          numericTeamId,
          report,
          payload,
        ),
      ),
    );
    return payload;
  }

  /** A report for one team (from the database) or the whole league (cached). */
  async function getReport(report, teamId, seasonId) {
    if (teamId) return await readTeamReport(report, teamId, seasonId);
    return await getOrFetchCached(
      CACHE_TYPES.PLAYER,
      LEAGUE_CACHE_KEYS[report](seasonId),
      () => REPORT_FETCHERS[report](seasonId),
      { seasonId },
    );
  }

  /** Fetches every report for one team from the NHL and stores them together. */
  async function refreshTeamReports(teamId, seasonId) {
    const reports = Object.values(TEAM_REPORTS);
    const payloads = await Promise.all(
      reports.map((report) => REPORT_FETCHERS[report](seasonId, teamId)),
    );
    await runInTransaction(async (client) => {
      for (const [index, report] of reports.entries()) {
        await teamStatReportRepository.upsertTeamStatReport(
          client,
          seasonId,
          teamId,
          report,
          payloads[index],
        );
      }
    });
  }

  /**
   * Refreshes both teams' stored reports once for each newly official
   * regular-season game. A game is claimed before its refresh and released
   * if the refresh fails, so the next poll retries it.
   *
   * @param {{ gameId: number, seasonId: string, gameType: number, teamIds: number[] }[]} games
   * @returns {Promise<{ ingested: number, failed: number }>}
   */
  async function ingestOfficialGames(games) {
    const regularSeasonGames = games.filter(
      (game) => game.gameType === REGULAR_SEASON_GAME_TYPE,
    );
    const outcomes = await Promise.allSettled(
      regularSeasonGames.map(async (game) => {
        const claimed = await runInTransaction((client) =>
          teamStatReportRepository.claimIngestedGame(client, game.gameId),
        );
        if (!claimed) return false;
        try {
          await Promise.all(
            game.teamIds.map((teamId) =>
              refreshTeamReports(teamId, game.seasonId),
            ),
          );
          return true;
        } catch (error) {
          await runInTransaction((client) =>
            teamStatReportRepository.releaseIngestedGame(client, game.gameId),
          );
          throw error;
        }
      }),
    );

    const summary = { ingested: 0, failed: 0 };
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        if (outcome.value) summary.ingested += 1;
        return;
      }
      summary.failed += 1;
      console.error(
        `Team stats for game ${regularSeasonGames[index].gameId} failed:`,
        outcome.reason?.message,
      );
    });
    return summary;
  }

  return {
    /** Normalized SkaterSummaryContract rows; every skater when no team is given. */
    async getSkaterSummary(teamId, seasonId) {
      return mapSkaterSummary(
        await getReport(TEAM_REPORTS.SKATER_SUMMARY, teamId, seasonId),
      );
    },

    /** Raw SAT/Corsi percentages, merged by playerId on the frontend. */
    async getSkaterCorsi(teamId, seasonId) {
      return await getReport(TEAM_REPORTS.SKATER_CORSI, teamId, seasonId);
    },

    /** Raw faceoff totals by zone, merged by playerId on the frontend. */
    async getSkaterFaceoffs(teamId, seasonId) {
      return await getReport(TEAM_REPORTS.SKATER_FACEOFFS, teamId, seasonId);
    },

    /** Normalized GoalieSummaryContract rows; every goalie when no team is given. */
    async getGoalieSummary(teamId, seasonId) {
      return mapGoalieSummary(
        await getReport(TEAM_REPORTS.GOALIE_SUMMARY, teamId, seasonId),
      );
    },

    ingestOfficialGames,
    persistPlayerStats,
  };
}

module.exports = {
  createPlayerStatsService,
  persistPlayerStats,
};
