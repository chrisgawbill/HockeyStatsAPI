const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

const SCHEDULE_GAME_ON_CONFLICT = `
	ON CONFLICT (game_id)
	DO UPDATE SET
		season_id = EXCLUDED.season_id,
		game_type = COALESCE(EXCLUDED.game_type, schedule_games.game_type),
		game_date = COALESCE(EXCLUDED.game_date, schedule_games.game_date),
		start_time_utc = COALESCE(
			EXCLUDED.start_time_utc,
			schedule_games.start_time_utc
		),
		game_state = COALESCE(EXCLUDED.game_state, schedule_games.game_state),
		venue_name = COALESCE(EXCLUDED.venue_name, schedule_games.venue_name),
		home_team_id = COALESCE(
			EXCLUDED.home_team_id,
			schedule_games.home_team_id
		),
		away_team_id = COALESCE(
			EXCLUDED.away_team_id,
			schedule_games.away_team_id
		),
		home_tri_code = COALESCE(
			EXCLUDED.home_tri_code,
			schedule_games.home_tri_code
		),
		away_tri_code = COALESCE(
			EXCLUDED.away_tri_code,
			schedule_games.away_tri_code
		),
		home_score = EXCLUDED.home_score,
		away_score = EXCLUDED.away_score,
		period_descriptor = EXCLUDED.period_descriptor,
		broadcasts = EXCLUDED.broadcasts,
		game_payload = EXCLUDED.game_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertScheduleGame}: dedupes by game_id. Returns
 * the number of unique games written.
 */
async function upsertScheduleGames(client, games) {
  return batchUpsert(
    client,
    {
      table: 'schedule_games',
      columns: [
        'game_id',
        'season_id',
        'game_type',
        'game_date',
        'start_time_utc',
        'game_state',
        'venue_name',
        'home_team_id',
        'away_team_id',
        'home_tri_code',
        'away_tri_code',
        'home_score',
        'away_score',
        'period_descriptor',
        'broadcasts',
        'game_payload',
      ],
      keyFn: (game) => String(game.gameId),
      onConflict: SCHEDULE_GAME_ON_CONFLICT,
      toParams: (game) => [
        game.gameId,
        game.seasonId,
        game.gameType ?? null,
        game.gameDate ?? null,
        game.startTimeUtc ?? null,
        game.gameState ?? null,
        game.venueName ?? null,
        game.homeTeamId ?? null,
        game.awayTeamId ?? null,
        game.homeTriCode ?? null,
        game.awayTriCode ?? null,
        game.homeScore ?? null,
        game.awayScore ?? null,
        toJsonParam(game.periodDescriptor, {}),
        toJsonParam(game.broadcasts, []),
        toJsonParam(game.gamePayload, {}),
      ],
    },
    games,
  );
}

async function getScheduleGamesBySeason(client, seasonId) {
  const result = await client.query(
    `
		SELECT to_jsonb(schedule_games) AS game
		FROM schedule_games
		WHERE season_id = $1
		ORDER BY game_date, start_time_utc, game_id
		`,
    [seasonId],
  );
  return result.rows;
}

module.exports = {
  upsertScheduleGames,
  getScheduleGamesBySeason,
};
