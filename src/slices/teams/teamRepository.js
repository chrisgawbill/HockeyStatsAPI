const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

const TEAM_ON_CONFLICT = `
	ON CONFLICT (team_id)
	DO UPDATE SET
		tri_code = COALESCE(EXCLUDED.tri_code, teams.tri_code),
		franchise_id = COALESCE(EXCLUDED.franchise_id, teams.franchise_id),
		full_name = COALESCE(EXCLUDED.full_name, teams.full_name),
		common_name = COALESCE(EXCLUDED.common_name, teams.common_name),
		place_name = COALESCE(EXCLUDED.place_name, teams.place_name),
		logo_url = COALESCE(EXCLUDED.logo_url, teams.logo_url),
		primary_color = COALESCE(EXCLUDED.primary_color, teams.primary_color),
		secondary_color = COALESCE(
			EXCLUDED.secondary_color,
			teams.secondary_color
		),
		source_payload = EXCLUDED.source_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertTeam}: dedupes by team_id (schedule
 * payloads repeat the same ~32 teams many times) and writes chunked multi-row
 * statements. Returns the number of unique teams written.
 */
async function upsertTeams(client, teams) {
  return batchUpsert(
    client,
    {
      table: 'teams',
      columns: [
        'team_id',
        'tri_code',
        'franchise_id',
        'full_name',
        'common_name',
        'place_name',
        'logo_url',
        'primary_color',
        'secondary_color',
        'source_payload',
      ],
      keyFn: (team) => String(team.teamId),
      onConflict: TEAM_ON_CONFLICT,
      toParams: (team) => [
        team.teamId,
        team.triCode,
        team.franchiseId ?? null,
        team.fullName ?? null,
        team.commonName ?? null,
        team.placeName ?? null,
        team.logoUrl ?? null,
        team.primaryColor ?? null,
        team.secondaryColor ?? null,
        toJsonParam(team.sourcePayload),
      ],
    },
    teams,
  );
}

const SNAPSHOT_ON_CONFLICT = `
	ON CONFLICT (season_id, team_id)
	DO UPDATE SET
		tri_code = EXCLUDED.tri_code,
		games_played = COALESCE(
			EXCLUDED.games_played,
			team_season_snapshots.games_played
		),
		wins = COALESCE(EXCLUDED.wins, team_season_snapshots.wins),
		losses = COALESCE(EXCLUDED.losses, team_season_snapshots.losses),
		ot_losses = COALESCE(
			EXCLUDED.ot_losses,
			team_season_snapshots.ot_losses
		),
		regulation_wins = COALESCE(
			EXCLUDED.regulation_wins,
			team_season_snapshots.regulation_wins
		),
		points = COALESCE(EXCLUDED.points, team_season_snapshots.points),
		goals_for = COALESCE(EXCLUDED.goals_for, team_season_snapshots.goals_for),
		goals_against = COALESCE(
			EXCLUDED.goals_against,
			team_season_snapshots.goals_against
		),
		goals_for_per_game = COALESCE(
			EXCLUDED.goals_for_per_game,
			team_season_snapshots.goals_for_per_game
		),
		goals_against_per_game = COALESCE(
			EXCLUDED.goals_against_per_game,
			team_season_snapshots.goals_against_per_game
		),
		power_play_pct = COALESCE(
			EXCLUDED.power_play_pct,
			team_season_snapshots.power_play_pct
		),
		penalty_kill_pct = COALESCE(
			EXCLUDED.penalty_kill_pct,
			team_season_snapshots.penalty_kill_pct
		),
		faceoff_win_pct = COALESCE(
			EXCLUDED.faceoff_win_pct,
			team_season_snapshots.faceoff_win_pct
		),
		division_name = COALESCE(
			EXCLUDED.division_name,
			team_season_snapshots.division_name
		),
		conference_name = COALESCE(
			EXCLUDED.conference_name,
			team_season_snapshots.conference_name
		),
		league_rank = COALESCE(
			EXCLUDED.league_rank,
			team_season_snapshots.league_rank
		),
		conference_rank = COALESCE(
			EXCLUDED.conference_rank,
			team_season_snapshots.conference_rank
		),
		division_rank = COALESCE(
			EXCLUDED.division_rank,
			team_season_snapshots.division_rank
		),
		snapshot_payload = EXCLUDED.snapshot_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertTeamSeasonSnapshot}: dedupes by
 * (season_id, team_id). Returns the number of unique snapshots written.
 */
async function upsertTeamSeasonSnapshots(client, snapshots) {
  return batchUpsert(
    client,
    {
      table: 'team_season_snapshots',
      columns: [
        'season_id',
        'team_id',
        'tri_code',
        'games_played',
        'wins',
        'losses',
        'ot_losses',
        'regulation_wins',
        'points',
        'goals_for',
        'goals_against',
        'goals_for_per_game',
        'goals_against_per_game',
        'power_play_pct',
        'penalty_kill_pct',
        'faceoff_win_pct',
        'division_name',
        'conference_name',
        'league_rank',
        'conference_rank',
        'division_rank',
        'snapshot_payload',
      ],
      keyFn: (snapshot) => JSON.stringify([snapshot.seasonId, snapshot.teamId]),
      onConflict: SNAPSHOT_ON_CONFLICT,
      toParams: (snapshot) => [
        snapshot.seasonId,
        snapshot.teamId,
        snapshot.triCode,
        snapshot.gamesPlayed ?? null,
        snapshot.wins ?? null,
        snapshot.losses ?? null,
        snapshot.otLosses ?? null,
        snapshot.regulationWins ?? null,
        snapshot.points ?? null,
        snapshot.goalsFor ?? null,
        snapshot.goalsAgainst ?? null,
        snapshot.goalsForPerGame ?? null,
        snapshot.goalsAgainstPerGame ?? null,
        snapshot.powerPlayPct ?? null,
        snapshot.penaltyKillPct ?? null,
        snapshot.faceoffWinPct ?? null,
        snapshot.divisionName ?? null,
        snapshot.conferenceName ?? null,
        snapshot.leagueRank ?? null,
        snapshot.conferenceRank ?? null,
        snapshot.divisionRank ?? null,
        toJsonParam(snapshot.snapshotPayload),
      ],
    },
    snapshots,
  );
}

async function getTeamSeasonSnapshots(client, seasonId) {
  const result = await client.query(
    `
		SELECT
			to_jsonb(s) AS snapshot,
			to_jsonb(t) AS team
		FROM team_season_snapshots s
		JOIN teams t ON t.team_id = s.team_id
		WHERE s.season_id = $1
		ORDER BY s.league_rank NULLS LAST, s.tri_code
		`,
    [seasonId],
  );
  return result.rows;
}

module.exports = {
  upsertTeams,
  upsertTeamSeasonSnapshots,
  getTeamSeasonSnapshots,
};
