const {
  mapSkaterSummary,
  mapGoalieSummary,
} = require('#slices/players/mappers/playerMapper.js');
const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const playersRepository = require('#slices/players/playersRepository.js');
const playerStatsRepository = require('#slices/players/playerStatsRepository.js');
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
 * Players slice service: cached regular-season skater/goalie stat reads for a
 * team (or the whole league) plus write-behind persistence.
 *
 * @param {{
 *   nhlApi: {
 *     axiosNhlStats: import('axios').AxiosInstance,
 *     axiosNhlGoalie: import('axios').AxiosInstance,
 *   },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 * }} deps
 */
function createPlayerStatsService({ nhlApi, cache, runServiceTask }) {
  const { axiosNhlStats, axiosNhlGoalie } = nhlApi;
  const { getOrFetchCached, CACHE_TYPES } = cache;

  /** NHL stats API filter for one season, optionally narrowed to one team. */
  function buildCayenneFilter(seasonId, teamId) {
    let filter = `seasonId=${seasonId} and gameTypeId=2`;
    if (teamId) filter += ` and teamId=${teamId}`;
    return encodeURIComponent(filter);
  }

  /**
   * Cache key for a summary. League-wide summaries hold every player (paged),
   * so they use their own key and never return an older 100-row entry.
   */
  function buildSummaryCacheKey(playerType, teamId, seasonId) {
    return teamId
      ? `${playerType}_summary_${teamId}_${seasonId}`
      : `${playerType}_summary_league_${seasonId}`;
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

  return {
    /** Normalized SkaterSummaryContract rows; every skater when no team is given. */
    async getSkaterSummary(teamId, seasonId) {
      const statsPayload = await getOrFetchCached(
        CACHE_TYPES.PLAYER,
        buildSummaryCacheKey('skater', teamId, seasonId),
        () =>
          fetchSummaryPayload({
            playerType: 'skater',
            statsClient: axiosNhlStats,
            sort: SKATER_SUMMARY_SORT,
            seasonId,
            teamId,
          }),
      );
      return mapSkaterSummary(statsPayload);
    },

    /** Raw SAT/Corsi percentages, merged by playerId on the frontend. */
    async getSkaterCorsi(teamId, seasonId) {
      return await getOrFetchCached(
        CACHE_TYPES.PLAYER,
        `skater_corsi_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlStats
            .get(
              `/percentages?cayenneExp=${buildCayenneFilter(seasonId, teamId)}&limit=100`,
            )
            .then((response) => response.data),
      );
    },

    /** Normalized GoalieSummaryContract rows; every goalie when no team is given. */
    async getGoalieSummary(teamId, seasonId) {
      const statsPayload = await getOrFetchCached(
        CACHE_TYPES.PLAYER,
        buildSummaryCacheKey('goalie', teamId, seasonId),
        () =>
          fetchSummaryPayload({
            playerType: 'goalie',
            statsClient: axiosNhlGoalie,
            sort: GOALIE_SUMMARY_SORT,
            seasonId,
            teamId,
          }),
      );
      return mapGoalieSummary(statsPayload);
    },

    persistPlayerStats,
  };
}

module.exports = {
  createPlayerStatsService,
  persistPlayerStats,
};
