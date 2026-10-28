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

/**
 * Upserts one category's leaders (and the players they reference) in a single
 * transaction. The season row goes first because everything references it, and
 * players go before leaders because stat_leaders.player_id references players.
 * Batching keeps the transaction to a handful of statements so the shared
 * seasons-row lock is held only briefly.
 */
async function persistStatLeaders({
  seasonId,
  playerType,
  category,
  leadersPayload,
  teamScope = 'all',
}) {
  const mappedLeaders = mapStatLeaderPayload({
    seasonId,
    playerType,
    category,
    leadersPayload,
    teamScope,
  });

  return await withTransaction(async (client) => {
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, {
        [`${playerType}Leaders`]: leadersPayload ?? null,
      }),
    );

    const playersUpserted = await playersRepository.upsertPlayers(
      client,
      mappedLeaders.rows.map((mappedRow) => mappedRow.player),
    );
    const leadersUpserted = await statLeadersRepository.upsertStatLeaders(
      client,
      mappedLeaders.rows.map((mappedRow) => mappedRow.leader),
    );

    return { playersUpserted, leadersUpserted, skipped: mappedLeaders.skipped };
  });
}

/**
 * The NHL API 404s a category (rather than returning an empty list) when
 * nobody qualifies for it yet, e.g. no goalie has a shutout early in a season.
 * Treats that as "no leaders yet" and rethrows every other error.
 */
function emptyLeadersWhenCategoryMissing(error) {
  if (error?.status === 404 || error?.response?.status === 404) {
    return {};
  }
  throw error;
}

/** True when the NHL API itself answered with a 5xx. */
function isNhlServerError(error) {
  const status = error?.status ?? error?.response?.status;
  return status >= 500 && status < 600;
}

/**
 * Stat-leaders slice service: top-10 leader reads per category/season,
 * normalized into StatLeaderContract rows. The raw leaders are stored reports
 * (playerStatsService), refreshed after official games; their write-behind
 * persistence runs when a category is fetched from the NHL.
 *
 * @param {{
 *   playerStatsService: { getLeaders: (playerType: string, category: string, seasonId: string) => Promise<object> },
 * }} deps
 */
function createStatLeaderService({ playerStatsService }) {
  /** Shared read path for both player types. */
  async function getLeaders(playerType, category, seasonId) {
    let leadersPayload;
    try {
      leadersPayload = await playerStatsService.getLeaders(
        playerType,
        category,
        seasonId,
      );
    } catch (error) {
      // The NHL API has answered a single empty category (goalie shutouts
      // early in a season) with a 5xx too. Serve no leaders for that category
      // rather than failing the request; nothing is stored, so the next
      // request asks again.
      if (!isNhlServerError(error)) throw error;
      console.warn(
        `NHL ${playerType} leaders ${category} ${seasonId} answered ${error.status ?? error.response?.status}; serving no leaders`,
      );
      return [];
    }
    return mapStatLeaders(leadersPayload, category);
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
  emptyLeadersWhenCategoryMissing,
};
