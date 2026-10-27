/**
 * Lists enabled Rink Quest team profiles with the canonical team fields,
 * optionally only `triCode`'s.
 */
async function listEnabledTeamProfiles(client, triCode = null) {
  const { rows: teamProfileRows } = await client.query(
    `
		SELECT t.team_id, t.tri_code, t.full_name, t.logo_url,
			p.primary_identity, p.secondary_identity
		FROM rink_quest_team_profiles p
		JOIN teams t ON t.team_id = p.team_id
		WHERE p.enabled
			AND ($1::text IS NULL OR t.tri_code = $1)
		ORDER BY t.tri_code
		`,
    [triCode],
  );
  return teamProfileRows;
}

/**
 * Lists `triCode`'s enabled skater profiles on its active roster for the
 * season. Roster rows are only ever upserted, and one refresh writes a team's
 * rows in one transaction with one `updated_at`, so a team's active roster is
 * its rows from its newest refresh. A traded player in two teams' newest
 * refreshes belongs to the more recent one.
 */
async function listActiveRosterCandidates(client, seasonId, triCode) {
  const { rows: candidateRows } = await client.query(
    `
		WITH season_entries AS (
			SELECT player_id, tri_code, position_code, sweater_number, updated_at,
				max(updated_at) OVER (PARTITION BY tri_code) AS team_refreshed_at
			FROM roster_entries
			WHERE season_id = $1
		),
		current_entries AS (
			SELECT DISTINCT ON (player_id) *
			FROM season_entries
			WHERE updated_at = team_refreshed_at
			ORDER BY player_id, updated_at DESC
		)
		SELECT e.player_id, pl.full_name, e.position_code, e.sweater_number,
			pl.headshot_url, p.archetype, p.appearance_rank
		FROM current_entries e
		JOIN rink_quest_player_profiles p ON p.player_id = e.player_id
		JOIN players pl ON pl.player_id = e.player_id
		WHERE e.tri_code = $2
			AND p.enabled
			AND e.position_code IS DISTINCT FROM 'G'
		ORDER BY p.archetype, p.appearance_rank, pl.full_name
		`,
    [seasonId, triCode],
  );
  return candidateRows;
}

module.exports = { listEnabledTeamProfiles, listActiveRosterCandidates };
