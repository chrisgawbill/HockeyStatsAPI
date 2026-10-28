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

/** The sweep refreshes again the teams of official games that started this recently. */
const RECENT_SWEEP_MS = 24 * 60 * 60 * 1000;

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
   * Claims the not yet ingested games among `games` and refreshes every team
   * that played in a claimed game or in one of `recentGames`, once each and
   * one team at a time. Claimed games of a team whose refresh failed are
   * released so a later poll or sweep retries them.
   */
  async function refreshTeamsForGames(games, recentGames = []) {
    const regularSeasonGames = games.filter(
      (game) => game.gameType === REGULAR_SEASON_GAME_TYPE,
    );
    const claimedGameIds = new Set(
      regularSeasonGames.length === 0
        ? []
        : await runInTransaction((client) =>
            teamStatReportRepository.claimIngestedGames(
              client,
              regularSeasonGames.map((game) => game.gameId),
            ),
          ),
    );
    const claimedGames = regularSeasonGames.filter((game) =>
      claimedGameIds.has(game.gameId),
    );

    const teams = new Map();
    for (const game of [...claimedGames, ...recentGames]) {
      if (game.gameType !== REGULAR_SEASON_GAME_TYPE) continue;
      for (const teamId of game.teamIds) {
        teams.set(`${game.seasonId}:${teamId}`, {
          teamId,
          seasonId: game.seasonId,
        });
      }
    }

    const failedTeamKeys = new Set();
    for (const [teamKey, { teamId, seasonId }] of teams) {
      try {
        await refreshTeamReports(teamId, seasonId);
      } catch (error) {
        failedTeamKeys.add(teamKey);
        console.error(
          `Team stats refresh ${teamId} ${seasonId} failed:`,
          error.message,
        );
      }
    }

    const failedGameIds = claimedGames
      .filter((game) =>
        game.teamIds.some((teamId) =>
          failedTeamKeys.has(`${game.seasonId}:${teamId}`),
        ),
      )
      .map((game) => game.gameId);
    if (failedGameIds.length > 0) {
      await runInTransaction((client) =>
        teamStatReportRepository.releaseIngestedGames(client, failedGameIds),
      );
    }

    return {
      ingested: claimedGames.length - failedGameIds.length,
      failed: failedGameIds.length,
      teamsRefreshed: teams.size - failedTeamKeys.size,
      teamsFailed: failedTeamKeys.size,
    };
  }

  /**
   * Refreshes both teams' stored reports once for each newly official
   * regular-season game, from the live poll.
   *
   * @param {{ gameId: number, seasonId: string, gameType: number, teamIds: number[] }[]} games
   */
  async function ingestOfficialGames(games) {
    return await refreshTeamsForGames(games);
  }

  /**
   * Backstop for the live poll, run with each scheduled schedule refresh:
   * ingests every official game of the season the poll missed (the API was
   * down, or the game is from before stats were stored), which also fills in
   * teams with no stored reports, and refreshes again every team that played
   * an official game in the last RECENT_SWEEP_MS, in case the NHL stats
   * service had not caught up when the poll ingested it.
   *
   * @param {{ gameId: number, seasonId: string, gameType: number, teamIds: number[], startTimeUTC: string }[]} officialGames
   */
  async function sweepTeamStats(officialGames, now = Date.now()) {
    const recentGames = officialGames.filter(
      (game) => now - Date.parse(game.startTimeUTC) <= RECENT_SWEEP_MS,
    );
    return await refreshTeamsForGames(officialGames, recentGames);
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
    sweepTeamStats,
    persistPlayerStats,
  };
}

module.exports = {
  createPlayerStatsService,
  persistPlayerStats,
};
