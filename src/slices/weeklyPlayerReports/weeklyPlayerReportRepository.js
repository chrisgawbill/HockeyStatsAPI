async function listFavoritePlayers(client, userId) {
  const result = await client.query(
    `
		SELECT player_id, full_name, team_tri_code, position, headshot, created_at, tier, label
		FROM favorite_players
		WHERE user_id = $1
		ORDER BY created_at, player_id
		`,
    [userId],
  );
  return result.rows;
}

/** Every favorite of every user, for the weekly dispatch. */
async function listAllFavoritePlayers(client) {
  const result = await client.query(
    `
		SELECT user_id, player_id, full_name, team_tri_code, position, headshot, created_at, tier, label
		FROM favorite_players
		ORDER BY user_id, created_at, player_id
		`,
  );
  return result.rows;
}

/**
 * Adds a favorite unless the user already has `limit` others. Re-favoriting
 * keeps the original `created_at` and refreshes the display fields. Returns
 * false only when the cap blocked a new favorite.
 */
async function insertFavoritePlayer(
  client,
  { userId, playerId, fullName, teamTriCode, position, headshot, limit },
) {
  // Serializes one user's adds so two tabs cannot both pass the cap check.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('favorite_players'), $1::int)",
    [userId],
  );
  const result = await client.query(
    `
		INSERT INTO favorite_players
			(user_id, player_id, full_name, team_tri_code, position, headshot)
		SELECT $1, $2, $3, $4, $5, $6
		WHERE EXISTS (
			SELECT 1 FROM favorite_players WHERE user_id = $1 AND player_id = $2
		) OR (
			SELECT count(*) FROM favorite_players WHERE user_id = $1
		) < $7
		ON CONFLICT (user_id, player_id) DO UPDATE
		SET full_name = EXCLUDED.full_name,
			team_tri_code = EXCLUDED.team_tri_code,
			position = EXCLUDED.position,
			headshot = EXCLUDED.headshot
		`,
    [userId, playerId, fullName, teamTriCode, position, headshot, limit],
  );
  return result.rowCount > 0;
}

async function deleteFavoritePlayer(client, { userId, playerId }) {
  await client.query(
    'DELETE FROM favorite_players WHERE user_id = $1 AND player_id = $2',
    [userId, playerId],
  );
}

/** Returns how many favorite rows were updated (0 when not a favorite). */
async function updateFavoritePlayerCategory(
  client,
  { userId, playerId, setTier, tier, setLabel, label },
) {
  const result = await client.query(
    `
		UPDATE favorite_players
		SET tier = CASE WHEN $3::boolean THEN $4::text ELSE tier END,
			label = CASE WHEN $5::boolean THEN $6::text ELSE label END
		WHERE user_id = $1 AND player_id = $2
		`,
    [userId, playerId, setTier, tier, setLabel, label],
  );
  return result.rowCount;
}

async function listReports(client, { userId, limit }) {
  const result = await client.query(
    `
		SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, payload, created_at, read_at
		FROM weekly_player_reports
		WHERE user_id = $1
		ORDER BY week_start DESC
		LIMIT $2
		`,
    [userId, limit],
  );
  return result.rows;
}

async function getReport(client, { userId, weekStart }) {
  const result = await client.query(
    `
		SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, payload, created_at, read_at
		FROM weekly_player_reports
		WHERE user_id = $1 AND week_start = $2::date
		`,
    [userId, weekStart],
  );
  return result.rows[0] ?? null;
}

/**
 * Stores a frozen report; an existing (user, week) row is never replaced.
 * Returns 1 when a row was created, else 0.
 */
async function insertReport(client, { userId, weekStart, payload }) {
  const result = await client.query(
    `
		INSERT INTO weekly_player_reports (user_id, week_start, payload)
		VALUES ($1, $2::date, $3::jsonb)
		ON CONFLICT (user_id, week_start) DO NOTHING
		`,
    [userId, weekStart, JSON.stringify(payload)],
  );
  return result.rowCount;
}

/** Returns how many rows were marked (0 when no such report). */
async function markReportRead(client, { userId, weekStart }) {
  const result = await client.query(
    `
		UPDATE weekly_player_reports
		SET read_at = COALESCE(read_at, now())
		WHERE user_id = $1 AND week_start = $2::date
		`,
    [userId, weekStart],
  );
  return result.rowCount;
}

/** All of the week's reports, for the push half of the dispatch. */
async function listReportsForWeek(client, weekStart) {
  const result = await client.query(
    `
		SELECT user_id, payload, read_at
		FROM weekly_player_reports
		WHERE week_start = $1::date
		ORDER BY user_id
		`,
    [weekStart],
  );
  return result.rows;
}

module.exports = {
  listFavoritePlayers,
  listAllFavoritePlayers,
  insertFavoritePlayer,
  deleteFavoritePlayer,
  updateFavoritePlayerCategory,
  listReports,
  getReport,
  insertReport,
  markReportRead,
  listReportsForWeek,
};
