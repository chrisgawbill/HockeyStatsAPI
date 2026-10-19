async function listFavoriteTeams(client, userId) {
  const result = await client.query(
    `
		SELECT team_tri_code, created_at, push_muted
		FROM favorite_teams
		WHERE user_id = $1
		ORDER BY created_at, team_tri_code
		`,
    [userId],
  );
  return result.rows;
}

/** Adds a favorite; re-favoriting keeps the original `created_at`. */
async function insertFavoriteTeam(client, { userId, triCode }) {
  await client.query(
    `
		INSERT INTO favorite_teams (user_id, team_tri_code)
		VALUES ($1, $2)
		ON CONFLICT (user_id, team_tri_code) DO NOTHING
		`,
    [userId, triCode],
  );
}

async function deleteFavoriteTeam(client, { userId, triCode }) {
  await client.query(
    'DELETE FROM favorite_teams WHERE user_id = $1 AND team_tri_code = $2',
    [userId, triCode],
  );
}

/** Returns the subset of `gameIds` this user has already opened. */
async function listReadGameIds(client, { userId, gameIds }) {
  if (gameIds.length === 0) return [];
  const result = await client.query(
    `
		SELECT game_id
		FROM after_action_report_reads
		WHERE user_id = $1 AND game_id = ANY($2::bigint[])
		`,
    [userId, gameIds],
  );
  return result.rows.map((row) => Number(row.game_id));
}

async function insertReadGameIds(client, { userId, gameIds }) {
  if (gameIds.length === 0) return;
  await client.query(
    `
		INSERT INTO after_action_report_reads (user_id, game_id)
		SELECT $1, UNNEST($2::bigint[])
		ON CONFLICT (user_id, game_id) DO NOTHING
		`,
    [userId, gameIds],
  );
}

/** Returns how many favorite rows were updated (0 when not a favorite). */
async function updateFavoritePushMuted(client, { userId, triCode, muted }) {
  const result = await client.query(
    `
		UPDATE favorite_teams
		SET push_muted = $3
		WHERE user_id = $1 AND team_tri_code = $2
		`,
    [userId, triCode, muted],
  );
  return result.rowCount;
}

module.exports = {
  updateFavoritePushMuted,
  listFavoriteTeams,
  insertFavoriteTeam,
  deleteFavoriteTeam,
  listReadGameIds,
  insertReadGameIds,
};
