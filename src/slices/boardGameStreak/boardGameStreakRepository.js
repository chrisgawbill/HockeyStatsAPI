const { toJsonParam } = require('#platform/jsonParam.js');

/** Fetches the user's stored streak row, or null. */
async function getStreak(client, userId) {
  const { rows: streakRows } = await client.query(
    'SELECT * FROM board_game_streaks WHERE user_id = $1',
    [userId],
  );
  return streakRows[0] ?? null;
}

/**
 * Replaces the stored streak row for `userId` with the already-merged
 * `{ wins, lastWinDate }` values (merging happens in the service, not here).
 */
async function upsertStreak(client, { userId, wins, lastWinDate }) {
  const { rows: upsertedStreakRows } = await client.query(
    `
		INSERT INTO board_game_streaks (user_id, wins, last_win_date, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (user_id)
		DO UPDATE SET
			wins = EXCLUDED.wins,
			last_win_date = EXCLUDED.last_win_date,
			updated_at = now()
		RETURNING *
		`,
    [userId, toJsonParam(wins), lastWinDate ?? null],
  );
  return upsertedStreakRows[0];
}

module.exports = {
  getStreak,
  upsertStreak,
};
