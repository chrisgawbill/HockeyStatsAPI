const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

const PLAYER_SEASON_STATS_ON_CONFLICT = `
	ON CONFLICT (
		season_id,
		player_id,
		player_type,
		stat_scope,
		team_scope
	)
	DO UPDATE SET
		team_id = COALESCE(
			EXCLUDED.team_id,
			player_season_stats.team_id
		),
		games_played = COALESCE(
			EXCLUDED.games_played,
			player_season_stats.games_played
		),
		goals = COALESCE(EXCLUDED.goals, player_season_stats.goals),
		assists = COALESCE(EXCLUDED.assists, player_season_stats.assists),
		points = COALESCE(EXCLUDED.points, player_season_stats.points),
		shots = COALESCE(EXCLUDED.shots, player_season_stats.shots),
		plus_minus = COALESCE(
			EXCLUDED.plus_minus,
			player_season_stats.plus_minus
		),
		penalty_minutes = COALESCE(
			EXCLUDED.penalty_minutes,
			player_season_stats.penalty_minutes
		),
		time_on_ice_per_game = COALESCE(
			EXCLUDED.time_on_ice_per_game,
			player_season_stats.time_on_ice_per_game
		),
		wins = COALESCE(EXCLUDED.wins, player_season_stats.wins),
		losses = COALESCE(EXCLUDED.losses, player_season_stats.losses),
		ot_losses = COALESCE(EXCLUDED.ot_losses, player_season_stats.ot_losses),
		save_pct = COALESCE(EXCLUDED.save_pct, player_season_stats.save_pct),
		goals_against_avg = COALESCE(
			EXCLUDED.goals_against_avg,
			player_season_stats.goals_against_avg
		),
		stats_payload = EXCLUDED.stats_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertPlayerSeasonStat}: dedupes by
 * (season_id, player_id, player_type, stat_scope, team_scope). The stat_scope
 * ('regular') and team_scope ('all') defaults are applied in the key so rows
 * omitting them collide exactly as the single-row upsert's param defaults do.
 * Returns the number of unique stat rows written.
 */
async function upsertPlayerSeasonStats(client, statsRows) {
  return batchUpsert(
    client,
    {
      table: 'player_season_stats',
      columns: [
        'season_id',
        'player_id',
        'team_id',
        'team_scope',
        'player_type',
        'stat_scope',
        'games_played',
        'goals',
        'assists',
        'points',
        'shots',
        'plus_minus',
        'penalty_minutes',
        'time_on_ice_per_game',
        'wins',
        'losses',
        'ot_losses',
        'save_pct',
        'goals_against_avg',
        'stats_payload',
      ],
      keyFn: (stats) =>
        JSON.stringify([
          stats.seasonId,
          stats.playerId,
          stats.playerType,
          stats.statScope ?? 'regular',
          stats.teamScope ?? 'all',
        ]),
      onConflict: PLAYER_SEASON_STATS_ON_CONFLICT,
      toParams: (stats) => [
        stats.seasonId,
        stats.playerId,
        stats.teamId ?? null,
        stats.teamScope ?? 'all',
        stats.playerType,
        stats.statScope ?? 'regular',
        stats.gamesPlayed ?? null,
        stats.goals ?? null,
        stats.assists ?? null,
        stats.points ?? null,
        stats.shots ?? null,
        stats.plusMinus ?? null,
        stats.penaltyMinutes ?? null,
        stats.timeOnIcePerGame ?? null,
        stats.wins ?? null,
        stats.losses ?? null,
        stats.otLosses ?? null,
        stats.savePct ?? null,
        stats.goalsAgainstAvg ?? null,
        toJsonParam(stats.statsPayload),
      ],
    },
    statsRows,
  );
}

async function getPlayerSeasonStats(client, seasonId, teamScope = 'all') {
  const result = await client.query(
    `
		SELECT
			to_jsonb(player_season_stats) AS stats,
			to_jsonb(players) AS player
		FROM player_season_stats
		JOIN players ON players.player_id = player_season_stats.player_id
		WHERE player_season_stats.season_id = $1
			AND player_season_stats.team_scope = $2
		ORDER BY player_season_stats.points DESC NULLS LAST, players.full_name
		`,
    [seasonId, teamScope],
  );
  return result.rows;
}

module.exports = {
  upsertPlayerSeasonStats,
  getPlayerSeasonStats,
};
