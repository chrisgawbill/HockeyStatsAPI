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
 * of the team/season snapshot. The summary is the stored `team_summary` report
 * (playerStatsService), per team or league-wide, refreshed after each game;
 * the snapshot is persisted when it is fetched from the NHL.
 *
 * @param {{
 *   playerStatsService: { getTeamSummary: (teamId: string | undefined, seasonId: string) => Promise<object> },
 * }} deps
 */
function createTeamService({ playerStatsService }) {

  return {
    /**
     * Regular-season team summary stats for one team, or the whole league when
     * `teamId` is omitted. Passed through unmapped (not yet normalized).
     */
    async getTeamSummary(teamId, seasonId) {
      return await playerStatsService.getTeamSummary(teamId, seasonId);
    },

    persistTeamSeason,
  };
}

module.exports = {
  createTeamService,
  persistTeamSeason,
};
