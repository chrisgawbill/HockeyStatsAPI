/** Lists a user's favorite teams, oldest first. */
async function listFavoriteTeams(client, userId) {
  const { rows: favoriteTeamRows } = await client.query(
    `
		SELECT team_tri_code, created_at, push_muted
		FROM favorite_teams
		WHERE user_id = $1
		ORDER BY created_at, team_tri_code
		`,
    [userId],
  );
  return favoriteTeamRows;
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

/** Removes a favorite team; a missing one is ignored. */
async function deleteFavoriteTeam(client, { userId, triCode }) {
  await client.query(
    'DELETE FROM favorite_teams WHERE user_id = $1 AND team_tri_code = $2',
    [userId, triCode],
  );
}

/** Returns the subset of `gameIds` this user has already opened. */
async function listReadGameIds(client, { userId, gameIds }) {
  if (gameIds.length === 0) return [];
  const { rows: readGameRows } = await client.query(
    `
		SELECT game_id
		FROM after_action_report_reads
		WHERE user_id = $1 AND game_id = ANY($2::bigint[])
		`,
    [userId, gameIds],
  );
  return readGameRows.map((readGameRow) => Number(readGameRow.game_id));
}

/** Marks games as read for the user; already-read games are ignored. */
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
  const { rowCount: updatedCount } = await client.query(
    `
		UPDATE favorite_teams
		SET push_muted = $3
		WHERE user_id = $1 AND team_tri_code = $2
		`,
    [userId, triCode, muted],
  );
  return updatedCount;
}

module.exports = {
  updateFavoritePushMuted,
  listFavoriteTeams,
  insertFavoriteTeam,
  deleteFavoriteTeam,
  listReadGameIds,
  insertReadGameIds,
};
