const {
  mapStatLeaders,
} = require('#slices/statLeaders/mappers/statLeaderMapper.js');
const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const playersRepository = require('#slices/players/playersRepository.js');
const statLeadersRepository = require('#slices/statLeaders/statLeaderRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const {
  mapStatLeaderPayload,
} = require('#slices/statLeaders/mappers/statLeaderDbMapper.js');

async function persistStatLeaders({
  seasonId,
  playerType,
  category,
  leadersPayload,
  teamScope = 'all',
}) {
  const mapped = mapStatLeaderPayload({
    seasonId,
    playerType,
    category,
    leadersPayload,
    teamScope,
  });

  return await withTransaction(async (client) => {
    // Create/lock the FK-parent season row first (children reference it), then
    // batch the children. Batching keeps the whole transaction ~a handful of
    // statements, so the shared seasons-row lock is held only briefly.
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, {
        [`${playerType}Leaders`]: leadersPayload ?? null,
      }),
    );

    // Players before leaders: stat_leaders.player_id references players.
    const playersUpserted = await playersRepository.upsertPlayers(
      client,
      mapped.rows.map((row) => row.player),
    );
    const leadersUpserted = await statLeadersRepository.upsertStatLeaders(
      client,
      mapped.rows.map((row) => row.leader),
    );

    return { playersUpserted, leadersUpserted, skipped: mapped.skipped };
  });
}

/**
 * Stat-leaders slice service: cached top-10 leader reads per category/season,
 * normalized into StatLeaderContract rows, plus write-behind persistence.
 *
 * @param {{
 *   nhlApi: { axiosNhl: import('axios').AxiosInstance },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 * }} deps
 */
function createStatLeaderService({ nhlApi, cache, runServiceTask }) {
  const { axiosNhl } = nhlApi;
  const { GetOrFetch, CACHE_TYPES } = cache;

  /** Shared read path for both player types; only the NHL path segment differs. */
  async function getLeaders(playerType, category, seasonId) {
    const endpoint =
      playerType === 'goalie' ? 'goalie-stats-leaders' : 'skater-stats-leaders';
    const raw = await GetOrFetch(
      CACHE_TYPES.STAT_LEADERS,
      `${playerType}_${category}_${seasonId}`,
      () =>
        axiosNhl
          .get(`/${endpoint}/${seasonId}/2?categories=${category}&limit=10`)
          .then((r) => r.data)
          .catch((error) => {
            // The NHL API 404s a category (rather than returning an empty
            // list) when nobody currently qualifies for it yet — routine
            // early in a season, e.g. no goalie has a shutout after a
            // handful of games. Treat that as "no leaders yet", not a
            // failure; any other status/network error still propagates.
            if (error?.status === 404 || error?.response?.status === 404) {
              return {};
            }
            throw error;
          }),
    );
    runServiceTask(`${playerType} leaders ${category} ${seasonId}`, () =>
      persistStatLeaders({
        seasonId,
        playerType,
        category,
        leadersPayload: raw,
      }),
    );
    return mapStatLeaders(raw, category);
  }

  return {
    getSkaterLeaders: (category, seasonId) =>
      getLeaders('skater', category, seasonId),
    getGoalieLeaders: (category, seasonId) =>
      getLeaders('goalie', category, seasonId),
    persistStatLeaders,
  };
}

module.exports = {
  createStatLeaderService,
  persistStatLeaders,
};
