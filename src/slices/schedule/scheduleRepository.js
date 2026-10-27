const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

/** SQL rank of a game state; mirrors GAME_STATE_PROGRESS in gameStatusOverlay. */
const gameStateRank = (column) =>
  `CASE ${column} WHEN 'FUT' THEN 0 WHEN 'PRE' THEN 1 WHEN 'LIVE' THEN 2 WHEN 'CRIT' THEN 2 WHEN 'FINAL' THEN 3 WHEN 'OFF' THEN 4 ELSE -1 END`;

// A schedule payload cached for hours must not move a game the live poll
// already advanced (LIVE, FINAL, OFF) back to an earlier state.
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
	WHERE ${gameStateRank('EXCLUDED.game_state')}
		>= ${gameStateRank('schedule_games.game_state')}
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

/** Lists a season's stored schedule games. */
async function getScheduleGamesBySeason(client, seasonId) {
  const { rows: scheduleGameRows } = await client.query(
    `
		SELECT to_jsonb(schedule_games) AS game
		FROM schedule_games
		WHERE season_id = $1
		ORDER BY game_date, start_time_utc, game_id
		`,
    [seasonId],
  );
  return scheduleGameRows;
}

/**
 * Writes polled live statuses onto existing schedule rows (rows come from the
 * season schedule persistence). Never moves a game back to an earlier state.
 * Returns the number of rows updated.
 * @param {{ gameId: number, gameState: string, homeScore: number|null, awayScore: number|null, periodDescriptor: object }[]} statuses
 */
async function updateGameStatuses(client, statuses) {
  if (statuses.length === 0) return 0;
  const { rowCount } = await client.query(
    `
		UPDATE schedule_games AS game
		SET
			game_state = polled.game_state,
			home_score = COALESCE(polled.home_score, game.home_score),
			away_score = COALESCE(polled.away_score, game.away_score),
			period_descriptor = COALESCE(polled.period_descriptor, game.period_descriptor),
			updated_at = now()
		FROM jsonb_to_recordset($1::jsonb) AS polled(
			game_id bigint,
			game_state text,
			home_score integer,
			away_score integer,
			period_descriptor jsonb
		)
		WHERE game.game_id = polled.game_id
			AND ${gameStateRank('polled.game_state')}
				>= ${gameStateRank('game.game_state')}
		`,
    [
      toJsonParam(
        statuses.map((status) => ({
          game_id: status.gameId,
          game_state: status.gameState,
          home_score: status.homeScore,
          away_score: status.awayScore,
          period_descriptor: status.periodDescriptor,
        })),
        [],
      ),
    ],
  );
  return rowCount;
}

module.exports = {
  upsertScheduleGames,
  updateGameStatuses,
  getScheduleGamesBySeason,
};
