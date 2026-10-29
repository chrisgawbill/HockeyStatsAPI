/** Lists one user's favorite players, oldest first. */
async function listFavoritePlayers(client, userId) {
  const { rows: favoritePlayerRows } = await client.query(
    `
		SELECT player_id, league, full_name, team_tri_code, position, headshot, created_at, tier, label, push_muted
		FROM favorite_players
		WHERE user_id = $1
		ORDER BY created_at, league, player_id
		`,
    [userId],
  );
  return favoritePlayerRows;
}

/** Every NHL favorite of every user, for the weekly dispatch. */
async function listAllFavoritePlayers(client) {
  const { rows: allFavoritePlayerRows } = await client.query(
    `
		SELECT user_id, player_id, league, full_name, team_tri_code, position, headshot, created_at, tier, label, push_muted
		FROM favorite_players
		WHERE league = 'nhl'
		ORDER BY user_id, created_at, player_id
		`,
  );
  return allFavoritePlayerRows;
}

/** Every user's NHL favorite teams with their fan category, for the weekly dispatch. */
async function listAllFavoriteTeams(client) {
  const { rows: allFavoriteTeamRows } = await client.query(
    `
		SELECT user_id, team_tri_code, tier, label
		FROM favorite_teams
		WHERE league = 'nhl'
		ORDER BY user_id, created_at, team_tri_code
		`,
  );
  return allFavoriteTeamRows;
}

/**
 * Adds a favorite unless the user already has `limit` others in either league
 * (the cap is shared). Re-favoriting
 * keeps the original `created_at` and refreshes the display fields. Returns
 * false only when the cap blocked a new favorite. A per-user advisory lock
 * serializes adds so two tabs cannot both pass the cap check.
 */
async function insertFavoritePlayer(
  client,
  { userId, playerId, league, fullName, teamTriCode, position, headshot, limit },
) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('favorite_players'), $1::int)",
    [userId],
  );
  const { rowCount: insertedCount } = await client.query(
    `
		INSERT INTO favorite_players
			(user_id, player_id, full_name, team_tri_code, position, headshot, league)
		SELECT $1, $2, $3, $4, $5, $6, $8
		WHERE EXISTS (
			SELECT 1 FROM favorite_players
			WHERE user_id = $1 AND player_id = $2 AND league = $8
		) OR (
			SELECT count(*) FROM favorite_players WHERE user_id = $1
		) < $7
		ON CONFLICT (user_id, league, player_id) DO UPDATE
		SET full_name = EXCLUDED.full_name,
			team_tri_code = EXCLUDED.team_tri_code,
			position = EXCLUDED.position,
			headshot = EXCLUDED.headshot
		`,
    [userId, playerId, fullName, teamTriCode, position, headshot, limit, league],
  );
  return insertedCount > 0;
}

/** Removes a favorite; a missing one is ignored. */
async function deleteFavoritePlayer(client, { userId, playerId, league }) {
  await client.query(
    'DELETE FROM favorite_players WHERE user_id = $1 AND player_id = $2 AND league = $3',
    [userId, playerId, league],
  );
}

/** Sets whether a favorite player counts in the weekly-report push; returns the updated row count (0 when not a favorite). */
async function updateFavoritePlayerPushMuted(
  client,
  { userId, playerId, league, muted },
) {
  const { rowCount: updatedCount } = await client.query(
    `
		UPDATE favorite_players
		SET push_muted = $3
		WHERE user_id = $1 AND player_id = $2 AND league = $4
		`,
    [userId, playerId, muted, league],
  );
  return updatedCount;
}

/** Sets a favorite player's tier and/or label; returns the updated row count (0 when not a favorite). */
async function updateFavoritePlayerCategory(
  client,
  { userId, playerId, league, changeTier, tier, changeLabel, label },
) {
  const { rowCount: updatedRowCount } = await client.query(
    `
		UPDATE favorite_players
		SET tier = CASE WHEN $3::boolean THEN $4::text ELSE tier END,
			label = CASE WHEN $5::boolean THEN $6::text ELSE label END
		WHERE user_id = $1 AND player_id = $2 AND league = $7
		`,
    [userId, playerId, changeTier, tier, changeLabel, label, league],
  );
  return updatedRowCount;
}

/** Lists a user's most recent reports, newest week first. */
async function listReports(client, { userId, limit }) {
  const { rows: reportRows } = await client.query(
    `
		SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, payload, created_at, read_at
		FROM weekly_player_reports
		WHERE user_id = $1
		ORDER BY week_start DESC
		LIMIT $2
		`,
    [userId, limit],
  );
  return reportRows;
}

/** Fetches one user's report for a week, or null. */
async function getReport(client, { userId, weekStart }) {
  const { rows: reportRows } = await client.query(
    `
		SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, payload, created_at, read_at
		FROM weekly_player_reports
		WHERE user_id = $1 AND week_start = $2::date
		`,
    [userId, weekStart],
  );
  return reportRows[0] ?? null;
}

/**
 * Stores a frozen report; an existing (user, week) row is never replaced.
 * Returns 1 when a row was created, else 0.
 */
async function insertReport(client, { userId, weekStart, payload }) {
  const { rowCount: insertedCount } = await client.query(
    `
		INSERT INTO weekly_player_reports (user_id, week_start, payload)
		VALUES ($1, $2::date, $3::jsonb)
		ON CONFLICT (user_id, week_start) DO NOTHING
		`,
    [userId, weekStart, JSON.stringify(payload)],
  );
  return insertedCount;
}

/** Returns how many rows were marked (0 when no such report). */
async function markReportRead(client, { userId, weekStart }) {
  const { rowCount: updatedCount } = await client.query(
    `
		UPDATE weekly_player_reports
		SET read_at = COALESCE(read_at, now())
		WHERE user_id = $1 AND week_start = $2::date
		`,
    [userId, weekStart],
  );
  return updatedCount;
}

/** All of the week's reports, for the push half of the dispatch. */
async function listReportsForWeek(client, weekStart) {
  const { rows: weekReportRows } = await client.query(
    `
		SELECT user_id, payload, read_at
		FROM weekly_player_reports
		WHERE week_start = $1::date
		ORDER BY user_id
		`,
    [weekStart],
  );
  return weekReportRows;
}

module.exports = {
  listFavoritePlayers,
  listAllFavoritePlayers,
  listAllFavoriteTeams,
  insertFavoritePlayer,
  deleteFavoritePlayer,
  updateFavoritePlayerCategory,
  updateFavoritePlayerPushMuted,
  listReports,
  getReport,
  insertReport,
  markReportRead,
  listReportsForWeek,
};
