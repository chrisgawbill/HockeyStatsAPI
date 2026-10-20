const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const teamsRepository = require('#slices/teams/teamRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const {
  mapTeamSeasonPayload,
} = require('#slices/teams/mappers/teamDbMapper.js');

/**
 * Upserts teams and team-season snapshots from raw NHL stats/standings payloads.
 *
 * Call this after `getOrFetchCached` has returned raw API data. The raw payload still
 * belongs in `app_cache`; this service stores the normalized app-facing rows.
 * The season row goes first (FK parent), then teams before snapshots
 * (team_season_snapshots references both seasons and teams).
 *
 * @param {object} params
 * @param {string} params.seasonId NHL season id such as "20252026".
 * @param {object} params.teamStatsPayload Raw NHL stats REST team summary payload.
 * @param {object} [params.standingsPayload] Optional raw NHL standings payload.
 * @returns {Promise<{teamsUpserted: number, snapshotsUpserted: number, skipped: number}>}
 */
async function persistTeamSeason({
  seasonId,
  teamStatsPayload,
  standingsPayload = null,
}) {
  const mappedTeams = mapTeamSeasonPayload({
    seasonId,
    teamStatsPayload,
    standingsPayload,
  });

  return await withTransaction(async (client) => {
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, {
        teamStats: teamStatsPayload ?? null,
        standings: standingsPayload ?? null,
      }),
    );

    const teamsUpserted = await teamsRepository.upsertTeams(
      client,
      mappedTeams.rows.map((mappedRow) => mappedRow.team),
    );
    const snapshotsUpserted = await teamsRepository.upsertTeamSeasonSnapshots(
      client,
      mappedTeams.rows.map((mappedRow) => mappedRow.snapshot),
    );

    return { teamsUpserted, snapshotsUpserted, skipped: mappedTeams.skipped };
  });
}

/**
 * Teams slice service: raw NHL team summary stats plus write-behind persistence
 * of the team/season snapshot.
 *
 * @param {{
 *   nhlApi: { axiosNhlTeam: import('axios').AxiosInstance },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 * }} deps
 */
function createTeamService({ nhlApi, cache, runServiceTask }) {
  const { axiosNhlTeam } = nhlApi;
  const { getOrFetchCached, CACHE_TYPES } = cache;

  return {
    /**
     * Regular-season team summary stats for one team, or the whole league when
     * `teamId` is omitted. Passed through unmapped (not yet normalized).
     */
    async getTeamSummary(teamId, seasonId) {
      const cayenneFilter = teamId
        ? `teamId=${teamId} and seasonId=${seasonId} and gameTypeId=2`
        : `seasonId=${seasonId} and gameTypeId=2`;
      const teamStatsPayload = await getOrFetchCached(
        CACHE_TYPES.TEAM,
        `summary_${teamId || 'all'}_${seasonId}`,
        () =>
          axiosNhlTeam
            .get(`/summary?cayenneExp=${encodeURIComponent(cayenneFilter)}`)
            .then((response) => response.data),
      );
      runServiceTask(`team summary ${teamId || 'all'} ${seasonId}`, () =>
        persistTeamSeason({ seasonId, teamStatsPayload }),
      );
      return teamStatsPayload;
    },

    persistTeamSeason,
  };
}

module.exports = {
  createTeamService,
  persistTeamSeason,
};
