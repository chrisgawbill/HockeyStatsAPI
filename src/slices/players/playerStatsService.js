const {
  mapSkaterSummary,
  mapGoalieSummary,
} = require('#slices/players/mappers/playerMapper.js');
const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const playersRepository = require('#slices/players/playersRepository.js');
const playerStatsRepository = require('#slices/players/playerStatsRepository.js');
const teamStatReportRepository = require('#slices/players/teamStatReportRepository.js');
const { persistTeamSeason } = require('#slices/teams/teamService.js');
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
  TEAM_SUMMARY: 'team_summary',
};

/** NHL game type of regular-season games, the only ones the reports count. */
const REGULAR_SEASON_GAME_TYPE = 2;

/** How long the poll waits before retrying a game whose stats were not caught up. */
const INGEST_RETRY_SECONDS = 10 * 60;

/**
 * Games a team's stored reports count: its goalies' starts, since exactly one
 * goalie starts each game. Null when nothing is stored.
 */
function countGoalieStarts(goalieSummaryPayload) {
  if (!goalieSummaryPayload) return null;
  return (goalieSummaryPayload.data ?? []).reduce(
    (starts, goalie) => starts + (goalie.gamesStarted ?? 0),
    0,
  );
}

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
 * (or the whole league) plus write-behind persistence. Also owns the stored
 * team summary report, which teamService reads for one team.
 *
 * Team-scoped reports are served from `team_stat_reports`, refreshed
 * for both teams when a game goes official (`ingestOfficialGames`), so the
 * team page shows a finished game's stats without calling the NHL. A report
 * missing from the database is fetched once and stored. League-wide reads
 * stay on the cache.
 *
 * @param {{
 *   nhlApi: {
 *     axiosNhlStats: import('axios').AxiosInstance,
 *     axiosNhlGoalie: import('axios').AxiosInstance,
 *     axiosNhlTeam: import('axios').AxiosInstance,
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
  const { axiosNhlStats, axiosNhlGoalie, axiosNhlTeam } = nhlApi;
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
    // Team-scoped only; teamService serves the league-wide summary from the
    // cache. A fresh fetch queues the team/season snapshot for the database.
    [TEAM_REPORTS.TEAM_SUMMARY]: async (seasonId, teamId) => {
      const cayenneFilter = `teamId=${teamId} and seasonId=${seasonId} and gameTypeId=2`;
      const teamStatsPayload = await axiosNhlTeam
        .get(`/summary?cayenneExp=${encodeURIComponent(cayenneFilter)}`)
        .then((response) => response.data);
      runServiceTask(`team summary ${teamId} ${seasonId}`, () =>
        persistTeamSeason({ seasonId, teamStatsPayload }),
      );
      return teamStatsPayload;
    },
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
    return countGoalieStarts(
      payloads[reports.indexOf(TEAM_REPORTS.GOALIE_SUMMARY)],
    );
  }

  /** Games counted by a team's stored reports, or null when none are stored. */
  async function readStoredGoalieStarts(teamId, seasonId) {
    return countGoalieStarts(
      await runInTransaction((client) =>
        teamStatReportRepository.getTeamStatReport(
          client,
          seasonId,
          teamId,
          TEAM_REPORTS.GOALIE_SUMMARY,
        ),
      ),
    );
  }

  /**
   * Refreshes both teams' stored reports once for each newly official
   * regular-season game, from the live poll. A game is claimed first, so the
   * poll (which keeps seeing an OFF game for hours) refreshes it once. When a
   * refresh fails, or its goalie starts did not grow by the team's claimed
   * games because the NHL stats service has not caught up yet, the team's
   * games stay not caught up and a poll retries them after
   * INGEST_RETRY_SECONDS.
   *
   * @param {{ gameId: number, seasonId: string, gameType: number, teamIds: number[] }[]} games
   * @returns {Promise<{ ingested: number, retrying: number }>}
   */
  async function ingestOfficialGames(games) {
    const regularSeasonGames = games.filter(
      (game) => game.gameType === REGULAR_SEASON_GAME_TYPE,
    );
    if (regularSeasonGames.length === 0) return { ingested: 0, retrying: 0 };
    const claimedGameIds = new Set(
      await runInTransaction((client) =>
        teamStatReportRepository.claimIngestedGames(
          client,
          regularSeasonGames.map((game) => game.gameId),
          INGEST_RETRY_SECONDS,
        ),
      ),
    );
    const claimedGames = regularSeasonGames.filter((game) =>
      claimedGameIds.has(game.gameId),
    );

    const teams = new Map();
    for (const game of claimedGames) {
      for (const teamId of game.teamIds) {
        const teamKey = `${game.seasonId}:${teamId}`;
        const team = teams.get(teamKey) ?? {
          teamId,
          seasonId: game.seasonId,
          newGames: 0,
        };
        team.newGames += 1;
        teams.set(teamKey, team);
      }
    }

    const retryTeamKeys = new Set();
    for (const [teamKey, { teamId, seasonId, newGames }] of teams) {
      try {
        const storedStarts = await readStoredGoalieStarts(teamId, seasonId);
        const refreshedStarts = await refreshTeamReports(teamId, seasonId);
        if (
          storedStarts !== null &&
          refreshedStarts < storedStarts + newGames
        ) {
          retryTeamKeys.add(teamKey);
          console.warn(
            `Team stats ${teamId} ${seasonId} not caught up yet; retrying next poll`,
          );
        }
      } catch (error) {
        retryTeamKeys.add(teamKey);
        console.error(
          `Team stats refresh ${teamId} ${seasonId} failed:`,
          error.message,
        );
      }
    }

    const retryGameIds = claimedGames
      .filter((game) =>
        game.teamIds.some((teamId) =>
          retryTeamKeys.has(`${game.seasonId}:${teamId}`),
        ),
      )
      .map((game) => game.gameId);
    const caughtUpGameIds = claimedGames
      .map((game) => game.gameId)
      .filter((gameId) => !retryGameIds.includes(gameId));
    if (caughtUpGameIds.length > 0) {
      await runInTransaction((client) =>
        teamStatReportRepository.markGamesCaughtUp(client, caughtUpGameIds),
      );
    }
    return { ingested: caughtUpGameIds.length, retrying: retryGameIds.length };
  }

  /**
   * Backstop for the live poll, run with each scheduled schedule refresh:
   * refreshes only the teams whose stored reports count fewer games (goalie
   * starts) than they have official regular-season games in `officialGames`,
   * or that have nothing stored. That covers games the poll missed, teams
   * never stored, and a poll that stored stats before the NHL caught up,
   * while an up-to-date team costs no NHL call.
   *
   * @param {{ gameId: number, seasonId: string, gameType: number, teamIds: number[] }[]} officialGames
   * @returns {Promise<{ teamsChecked: number, teamsRefreshed: number, teamsBehind: number, teamsFailed: number }>}
   */
  async function sweepTeamStats(officialGames) {
    const teams = new Map();
    for (const game of officialGames) {
      if (game.gameType !== REGULAR_SEASON_GAME_TYPE) continue;
      for (const teamId of game.teamIds) {
        const teamKey = `${game.seasonId}:${teamId}`;
        const team = teams.get(teamKey) ?? {
          teamId,
          seasonId: game.seasonId,
          officialGames: 0,
        };
        team.officialGames += 1;
        teams.set(teamKey, team);
      }
    }

    const storedStartsByTeamKey = new Map();
    for (const seasonId of new Set(
      [...teams.values()].map((team) => team.seasonId),
    )) {
      const storedReports = await runInTransaction((client) =>
        teamStatReportRepository.listTeamStatReports(
          client,
          seasonId,
          TEAM_REPORTS.GOALIE_SUMMARY,
        ),
      );
      for (const { teamId, payload } of storedReports) {
        storedStartsByTeamKey.set(
          `${seasonId}:${teamId}`,
          countGoalieStarts(payload),
        );
      }
    }

    const summary = {
      teamsChecked: teams.size,
      teamsRefreshed: 0,
      teamsBehind: 0,
      teamsFailed: 0,
    };
    for (const [teamKey, { teamId, seasonId, officialGames: games }] of teams) {
      if ((storedStartsByTeamKey.get(teamKey) ?? -1) >= games) continue;
      try {
        const refreshedStarts = await refreshTeamReports(teamId, seasonId);
        summary.teamsRefreshed += 1;
        if (refreshedStarts < games) summary.teamsBehind += 1;
      } catch (error) {
        summary.teamsFailed += 1;
        console.error(
          `Team stats sweep ${teamId} ${seasonId} failed:`,
          error.message,
        );
      }
    }
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

    /** Raw NHL team summary for one team, from the database. */
    async getTeamSummary(teamId, seasonId) {
      return await readTeamReport(TEAM_REPORTS.TEAM_SUMMARY, teamId, seasonId);
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
