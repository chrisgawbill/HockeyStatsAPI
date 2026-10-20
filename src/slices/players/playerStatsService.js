const {
  mapSkaterSummary,
  mapGoalieSummary,
} = require('#slices/players/mappers/playerMapper.js');
const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const playersRepository = require('#slices/players/playersRepository.js');
const playerStatsRepository = require('#slices/players/playerStatsRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const {
  mapPlayerStatsPayload,
} = require('#slices/players/mappers/playerStatsDbMapper.js');

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

  return {
    /** Normalized SkaterSummaryContract rows. */
    async getSkaterSummary(teamId, seasonId) {
      const statsPayload = await getOrFetchCached(
        CACHE_TYPES.PLAYER,
        `skater_summary_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlStats
            .get(
              `/summary?cayenneExp=${buildCayenneFilter(seasonId, teamId)}&limit=100`,
            )
            .then((response) => response.data),
      );
      runServiceTask(`skater summary ${teamId || 'all'} ${seasonId}`, () =>
        persistPlayerStats({
          seasonId,
          playerType: 'skater',
          statsPayload,
          teamId: teamId ? Number(teamId) : null,
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

    /** Normalized GoalieSummaryContract rows. */
    async getGoalieSummary(teamId, seasonId) {
      const statsPayload = await getOrFetchCached(
        CACHE_TYPES.PLAYER,
        `goalie_summary_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlGoalie
            .get(
              `/summary?cayenneExp=${buildCayenneFilter(seasonId, teamId)}&limit=100`,
            )
            .then((response) => response.data),
      );
      runServiceTask(`goalie summary ${teamId || 'all'} ${seasonId}`, () =>
        persistPlayerStats({
          seasonId,
          playerType: 'goalie',
          statsPayload,
          teamId: teamId ? Number(teamId) : null,
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
