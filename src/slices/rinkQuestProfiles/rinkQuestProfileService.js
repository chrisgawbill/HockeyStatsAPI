const createError = require('http-errors');
const repository = require('#slices/rinkQuestProfiles/rinkQuestProfileRepository.js');

const TRI_CODE_PATTERN = /^[A-Z]{3}$/;

/** Maps a team profile row to the API shape. */
function mapTeamProfileRow(row) {
  return {
    teamId: row.team_id,
    triCode: row.tri_code,
    name: row.full_name ?? null,
    logoUrl: row.logo_url ?? null,
    primaryIdentity: row.primary_identity,
    secondaryIdentity: row.secondary_identity ?? null,
  };
}

/** Maps a candidate row to the API shape; ids stay numbers. */
function mapCandidateRow(row) {
  return {
    playerId: Number(row.player_id),
    name: row.full_name ?? null,
    positionCode: row.position_code ?? null,
    sweaterNumber: row.sweater_number ?? null,
    headshotUrl: row.headshot_url ?? null,
    archetype: row.archetype,
    appearanceRank: row.appearance_rank,
  };
}

/**
 * Rink Quest team and player profiles. Only stored, enabled profiles are
 * returned; canonical names, positions, rosters and headshots are joined in.
 */
function createRinkQuestProfileService({ withTransaction, seasons, rosterService }) {
  /** Every enabled team profile. */
  async function listTeams() {
    const teamProfileRows = await withTransaction((client) =>
      repository.listEnabledTeamProfiles(client),
    );
    return { teams: teamProfileRows.map(mapTeamProfileRow) };
  }

  /** An enabled team's profile and its enabled active-roster skater profiles. */
  async function listCandidates(triCode) {
    const teamTriCode = String(triCode).toUpperCase();
    if (!TRI_CODE_PATTERN.test(teamTriCode)) {
      throw createError(400, 'Invalid team tri-code.');
    }
    const [teamProfileRow] = await withTransaction((client) =>
      repository.listEnabledTeamProfiles(client, teamTriCode),
    );
    if (!teamProfileRow) {
      throw createError(404, 'Team is not enabled for Rink Quest.');
    }

    const seasonId = seasons.getCurrentSeasonId();
    try {
      await rosterService.refreshRoster(teamTriCode, seasonId);
    } catch (error) {
      // Stored roster rows are still a valid (older) answer.
      console.warn(`Roster refresh ${teamTriCode} ${seasonId} failed; using stored roster: ${error.message}`);
    }
    const candidateRows = await withTransaction((client) =>
      repository.listActiveRosterCandidates(client, seasonId, teamTriCode),
    );
    return {
      team: mapTeamProfileRow(teamProfileRow),
      candidates: candidateRows.map(mapCandidateRow),
    };
  }

  return { listTeams, listCandidates };
}

module.exports = { createRinkQuestProfileService };
