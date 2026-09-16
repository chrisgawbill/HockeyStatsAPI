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

async function persistPlayerStats({
  seasonId,
  playerType,
  statsPayload,
  teamId = null,
  teamScope = teamId ? String(teamId) : 'all',
}) {
  const mapped = mapPlayerStatsPayload({
    seasonId,
    playerType,
    statsPayload,
    teamId,
    teamScope,
  });

  return await withTransaction(async (client) => {
    // Season row first (FK parent), then players before stats
    // (player_season_stats references players).
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, { [`${playerType}Stats`]: statsPayload ?? null }),
    );

    const playersUpserted = await playersRepository.upsertPlayers(
      client,
      mapped.rows.map((row) => row.player),
    );
    const statsUpserted = await playerStatsRepository.upsertPlayerSeasonStats(
      client,
      mapped.rows.map((row) => row.stats),
    );

    return { playersUpserted, statsUpserted, skipped: mapped.skipped };
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
  const { GetOrFetch, CACHE_TYPES } = cache;

  /** NHL stats API filter for one season, optionally narrowed to one team. */
  function cayenneExp(seasonId, teamId) {
    let exp = `seasonId=${seasonId} and gameTypeId=2`;
    if (teamId) exp += ` and teamId=${teamId}`;
    return encodeURIComponent(exp);
  }

  return {
    /** Normalized SkaterSummaryContract rows. */
    async getSkaterSummary(teamId, seasonId) {
      const raw = await GetOrFetch(
        CACHE_TYPES.PLAYER,
        `skater_summary_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlStats
            .get(
              `/summary?cayenneExp=${cayenneExp(seasonId, teamId)}&limit=100`,
            )
            .then((r) => r.data),
      );
      runServiceTask(`skater summary ${teamId || 'all'} ${seasonId}`, () =>
        persistPlayerStats({
          seasonId,
          playerType: 'skater',
          statsPayload: raw,
          teamId: teamId ? Number(teamId) : null,
        }),
      );
      return mapSkaterSummary(raw);
    },

    /** Raw SAT/Corsi percentages, merged by playerId on the frontend. */
    async getSkaterCorsi(teamId, seasonId) {
      return await GetOrFetch(
        CACHE_TYPES.PLAYER,
        `skater_corsi_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlStats
            .get(
              `/percentages?cayenneExp=${cayenneExp(seasonId, teamId)}&limit=100`,
            )
            .then((r) => r.data),
      );
    },

    /** Normalized GoalieSummaryContract rows. */
    async getGoalieSummary(teamId, seasonId) {
      const raw = await GetOrFetch(
        CACHE_TYPES.PLAYER,
        `goalie_summary_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlGoalie
            .get(
              `/summary?cayenneExp=${cayenneExp(seasonId, teamId)}&limit=100`,
            )
            .then((r) => r.data),
      );
      runServiceTask(`goalie summary ${teamId || 'all'} ${seasonId}`, () =>
        persistPlayerStats({
          seasonId,
          playerType: 'goalie',
          statsPayload: raw,
          teamId: teamId ? Number(teamId) : null,
        }),
      );
      return mapGoalieSummary(raw);
    },

    persistPlayerStats,
  };
}

module.exports = {
  createPlayerStatsService,
  persistPlayerStats,
};
