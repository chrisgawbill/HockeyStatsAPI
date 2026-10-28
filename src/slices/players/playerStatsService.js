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
const {
  persistStatLeaders,
  emptyLeadersWhenCategoryMissing,
} = require('#slices/statLeaders/statLeaderService.js');
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

/**
 * `team_id` the league-wide reports are stored under; no NHL team has id 0.
 * League-wide rows come from the NHL's league-wide queries rather than from
 * the 32 team reports, since a traded player has one row per team there.
 */
const LEAGUE_TEAM_ID = 0;

/** Reports stored league-wide, refreshed together after official games. */
const LEAGUE_REPORTS = Object.values(TEAM_REPORTS);

/**
 * Stat leader reports are stored league-wide as `<playerType>_leaders:<category>`,
 * one per category a request has asked for. A stored category is refreshed with
 * the other league-wide reports.
 */
const LEADER_REPORT_SUFFIX = '_leaders:';
const leaderReport = (playerType, category) =>
  `${playerType}${LEADER_REPORT_SUFFIX}${category}`;

/** Sort for paging league-wide Corsi and faceoff rows: unique, so pages never overlap. */
const PLAYER_ID_SORT = [{ property: 'playerId', direction: 'ASC' }];

/**
 * Stored reports not refreshed for this long are re-fetched from the NHL by the
 * sweep, as a weekly check against the NHL even for a team that has not played.
 */
const STALE_REPORT_MS = 7 * 24 * 60 * 60 * 1000;

/** NHL game type of regular-season games, the only ones the reports count. */
const REGULAR_SEASON_GAME_TYPE = 2;

/** Report scopes a game changes: both teams and the league. */
const gameScopes = (game) => [...game.teamIds, LEAGUE_TEAM_ID];

/**
 * Goalie starts a game adds to a scope's reports: one per team, and both
 * teams' starts league-wide.
 */
const startsPerGame = (teamId) => (teamId === LEAGUE_TEAM_ID ? 2 : 1);

/**
 * Groups regular-season games by report scope (each team, plus the league per
 * season) as `season:teamId` -> { teamId, seasonId, starts }, where `starts`
 * is the goalie starts those games add to the scope's reports.
 */
function groupStartsByScope(games) {
  const scopes = new Map();
  for (const game of games) {
    if (game.gameType !== REGULAR_SEASON_GAME_TYPE) continue;
    for (const teamId of gameScopes(game)) {
      const scopeKey = `${game.seasonId}:${teamId}`;
      const scope = scopes.get(scopeKey) ?? {
        teamId,
        seasonId: game.seasonId,
        starts: 0,
      };
      scope.starts += startsPerGame(teamId);
      scopes.set(scopeKey, scope);
    }
  }
  return scopes;
}

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
 * team summary and stat leader reports, which teamService and
 * statLeaderService read.
 *
 * Every report is served from `team_stat_reports`: per team, and league-wide
 * under LEAGUE_TEAM_ID. Both teams' reports and the league-wide ones are
 * refreshed when a game goes official (`ingestOfficialGames`), and the sweep
 * re-fetches anything behind or not refreshed in a week, so reads never call
 * the NHL. A report missing from the database (a past season, a new category)
 * is fetched once and stored.
 *
 * @param {{
 *   nhlApi: {
 *     axiosNhlStats: import('axios').AxiosInstance,
 *     axiosNhlGoalie: import('axios').AxiosInstance,
 *     axiosNhlTeam: import('axios').AxiosInstance,
 *     axiosNhl: import('axios').AxiosInstance,
 *   },
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 * }} deps
 */
function createPlayerStatsService({
  nhlApi,
  runServiceTask,
  withTransaction: runInTransaction = withTransaction,
  now = Date.now,
}) {
  const { axiosNhlStats, axiosNhlGoalie, axiosNhlTeam, axiosNhl } = nhlApi;

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

  /**
   * A skater report without write-behind: one team fits one page; the whole
   * league is paged on player id so every skater is stored.
   */
  function fetchSkaterReport(path, seasonId, teamId) {
    const filter = buildCayenneFilter(seasonId, teamId);
    if (teamId) {
      return axiosNhlStats
        .get(`${path}?cayenneExp=${filter}&limit=100`)
        .then((response) => response.data);
    }
    const sortParam = encodeURIComponent(JSON.stringify(PLAYER_ID_SORT));
    return fetchAllStatsRows((start, limit) =>
      axiosNhlStats
        .get(
          `${path}?cayenneExp=${filter}&sort=${sortParam}&start=${start}&limit=${limit}`,
        )
        .then((response) => response.data),
    );
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
      fetchSkaterReport('/percentages', seasonId, teamId),
    [TEAM_REPORTS.SKATER_FACEOFFS]: (seasonId, teamId) =>
      fetchSkaterReport('/faceoffpercentages', seasonId, teamId),
    [TEAM_REPORTS.GOALIE_SUMMARY]: (seasonId, teamId) =>
      fetchSummaryPayload({
        playerType: 'goalie',
        statsClient: axiosNhlGoalie,
        sort: GOALIE_SUMMARY_SORT,
        seasonId,
        teamId,
      }),
    // A fresh fetch queues the team/season snapshot for the database.
    [TEAM_REPORTS.TEAM_SUMMARY]: async (seasonId, teamId) => {
      const teamStatsPayload = await axiosNhlTeam
        .get(`/summary?cayenneExp=${buildCayenneFilter(seasonId, teamId)}`)
        .then((response) => response.data);
      runServiceTask(`team summary ${teamId || 'all'} ${seasonId}`, () =>
        persistTeamSeason({ seasonId, teamStatsPayload }),
      );
      return teamStatsPayload;
    },
  };

  /**
   * Top-10 leaders for one category, as the raw api-web payload. A category
   * nobody qualifies for yet is an empty payload; a fresh fetch queues the
   * leaders for the database.
   */
  async function fetchLeaders(playerType, category, seasonId) {
    const endpoint =
      playerType === 'goalie' ? 'goalie-stats-leaders' : 'skater-stats-leaders';
    const leadersPayload = await axiosNhl
      .get(`/${endpoint}/${seasonId}/2?categories=${category}&limit=10`)
      .then((response) => response.data)
      .catch(emptyLeadersWhenCategoryMissing);
    runServiceTask(`${playerType} leaders ${category} ${seasonId}`, () =>
      persistStatLeaders({ seasonId, playerType, category, leadersPayload }),
    );
    return leadersPayload;
  }

  /** Fetches one report from the NHL, for a team or LEAGUE_TEAM_ID. */
  function fetchReport(report, seasonId, teamId) {
    const [kind, category] = report.split(':');
    if (category) {
      return fetchLeaders(kind.replace(/_leaders$/, ''), category, seasonId);
    }
    const nhlTeamId = teamId === LEAGUE_TEAM_ID ? undefined : teamId;
    return REPORT_FETCHERS[report](seasonId, nhlTeamId);
  }

  /**
   * Whether a fetched payload is stored. A leaders payload is stored only when
   * it lists the category, so an empty or unknown category is not stored and
   * is asked again next time.
   */
  function isStorable(report, payload) {
    const [, category] = report.split(':');
    return !category || Array.isArray(payload?.[category]);
  }

  /**
   * A team's (or the league's) report from the database; fetched from the NHL
   * and stored when missing, such as a season never stored. If the database
   * cannot be read, the NHL payload is served unstored.
   */
  async function readStoredReport(report, teamId, seasonId) {
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
      return await fetchReport(report, seasonId, numericTeamId);
    }
    if (storedPayload) return storedPayload;

    const payload = await fetchReport(report, seasonId, numericTeamId);
    if (!isStorable(report, payload)) return payload;
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

  /** A report for one team, or the whole league when no team is given. */
  async function getReport(report, teamId, seasonId) {
    return await readStoredReport(report, teamId || LEAGUE_TEAM_ID, seasonId);
  }

  /** Fetches `reports` from the NHL and stores them together. */
  async function storeFetchedReports(teamId, seasonId, reports) {
    const payloads = await Promise.all(
      reports.map((report) => fetchReport(report, seasonId, teamId)),
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
    return payloads[reports.indexOf(TEAM_REPORTS.GOALIE_SUMMARY)];
  }

  /**
   * Fetches every report for one team, or for the league under
   * LEAGUE_TEAM_ID, from the NHL and stores them together. Returns the goalie
   * starts the refreshed reports count. League-wide, the stored leader
   * categories are refreshed too; one failing (the NHL has answered an empty
   * category with a 5xx) keeps its stored payload.
   */
  async function refreshTeamReports(teamId, seasonId) {
    if (teamId !== LEAGUE_TEAM_ID) {
      return countGoalieStarts(
        await storeFetchedReports(teamId, seasonId, Object.values(TEAM_REPORTS)),
      );
    }
    const goalieSummary = await storeFetchedReports(
      teamId,
      seasonId,
      LEAGUE_REPORTS,
    );
    const leaderReports = (
      await runInTransaction((client) =>
        teamStatReportRepository.listStoredReports(client, seasonId, teamId),
      )
    ).filter((report) => report.includes(LEADER_REPORT_SUFFIX));
    for (const report of leaderReports) {
      try {
        await storeFetchedReports(teamId, seasonId, [report]);
      } catch (error) {
        console.error(
          `Refreshing ${report} ${seasonId} failed:`,
          error.message,
        );
      }
    }
    return countGoalieStarts(goalieSummary);
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
   * Refreshes both teams' stored reports, and the league-wide ones, once for
   * each newly official regular-season game, from the live poll. A game is
   * claimed first, so the poll (which keeps seeing an OFF game for hours)
   * refreshes it once. When a refresh fails, or its goalie starts did not grow
   * by the claimed games' starts because the NHL stats service has not caught
   * up yet, that scope's games stay not caught up and a poll retries them
   * after INGEST_RETRY_SECONDS.
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

    const retryTeamKeys = new Set();
    for (const [teamKey, { teamId, seasonId, starts: newStarts }] of
      groupStartsByScope(claimedGames)) {
      try {
        const storedStarts = await readStoredGoalieStarts(teamId, seasonId);
        const refreshedStarts = await refreshTeamReports(teamId, seasonId);
        if (
          storedStarts !== null &&
          refreshedStarts < storedStarts + newStarts
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
        gameScopes(game).some((teamId) =>
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
   * refreshes only the scopes (each team, and the league) whose stored
   * reports count fewer goalie starts than their official regular-season
   * games in `officialGames` add up to, that have nothing stored, or that
   * were last refreshed over STALE_REPORT_MS ago. That covers games the poll
   * missed, teams never stored, a poll that stored stats before the NHL
   * caught up, and a weekly check against the NHL, while an up-to-date scope
   * costs no NHL call.
   *
   * @param {{ gameId: number, seasonId: string, gameType: number, teamIds: number[] }[]} officialGames
   * @returns {Promise<{ teamsChecked: number, teamsRefreshed: number, teamsStale: number, teamsBehind: number, teamsFailed: number }>}
   */
  async function sweepTeamStats(officialGames) {
    const scopes = groupStartsByScope(officialGames);

    const storedByScopeKey = new Map();
    for (const seasonId of new Set(
      [...scopes.values()].map((scope) => scope.seasonId),
    )) {
      const storedReports = await runInTransaction((client) =>
        teamStatReportRepository.listTeamStatReports(
          client,
          seasonId,
          TEAM_REPORTS.GOALIE_SUMMARY,
        ),
      );
      for (const { teamId, payload, updatedAt } of storedReports) {
        storedByScopeKey.set(`${seasonId}:${teamId}`, {
          starts: countGoalieStarts(payload),
          updatedAt,
        });
      }
    }

    const summary = {
      teamsChecked: scopes.size,
      teamsRefreshed: 0,
      teamsStale: 0,
      teamsBehind: 0,
      teamsFailed: 0,
    };
    for (const [scopeKey, { teamId, seasonId, starts }] of scopes) {
      const stored = storedByScopeKey.get(scopeKey);
      const isStale =
        stored && now() - new Date(stored.updatedAt).getTime() > STALE_REPORT_MS;
      if (stored && stored.starts >= starts && !isStale) continue;
      try {
        const refreshedStarts = await refreshTeamReports(teamId, seasonId);
        summary.teamsRefreshed += 1;
        if (isStale) summary.teamsStale += 1;
        if (refreshedStarts < starts) summary.teamsBehind += 1;
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

    /** Raw NHL team summary for one team, or every team when none is given. */
    async getTeamSummary(teamId, seasonId) {
      return await getReport(TEAM_REPORTS.TEAM_SUMMARY, teamId, seasonId);
    },

    /** Raw api-web leaders payload for one category, from the database. */
    async getLeaders(playerType, category, seasonId) {
      return await readStoredReport(
        leaderReport(playerType, category),
        LEAGUE_TEAM_ID,
        seasonId,
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
