/** Lists a user's favorite teams, oldest first. */
async function listFavoriteTeams(client, userId) {
  const { rows: favoriteTeamRows } = await client.query(
    `
		SELECT team_tri_code, league, created_at, push_muted, tier, label
		FROM favorite_teams
		WHERE user_id = $1
		ORDER BY created_at, league, team_tri_code
		`,
    [userId],
  );
  return favoriteTeamRows;
}

/**
 * Adds a favorite unless the user already has `limit` others in either
 * league (the cap is shared); re-favoriting
 * keeps the original `created_at`. Returns false only when the cap blocked a
 * new favorite. A per-user advisory lock serializes adds so two tabs cannot
 * both pass the cap check.
 */
async function insertFavoriteTeam(client, { userId, triCode, league, limit }) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('favorite_teams'), $1::int)",
    [userId],
  );
  const {
    rows: [favoriteCounts],
  } = await client.query(
    `
		SELECT
			COALESCE(bool_or(team_tri_code = $2 AND league = $3), false) AS is_already_favorite,
			count(*)::int AS favorite_count
		FROM favorite_teams
		WHERE user_id = $1
		`,
    [userId, triCode, league],
  );
  if (favoriteCounts.is_already_favorite) return true;
  if (favoriteCounts.favorite_count >= limit) return false;
  await client.query(
    `
		INSERT INTO favorite_teams (user_id, team_tri_code, league)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, league, team_tri_code) DO NOTHING
		`,
    [userId, triCode, league],
  );
  return true;
}

/** Removes a favorite team; a missing one is ignored. */
async function deleteFavoriteTeam(client, { userId, triCode, league }) {
  await client.query(
    'DELETE FROM favorite_teams WHERE user_id = $1 AND team_tri_code = $2 AND league = $3',
    [userId, triCode, league],
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

/** Sets a favorite team's tier and/or label; returns the updated row count (0 when not a favorite). */
async function updateFavoritePushMuted(client, { userId, triCode, league, muted }) {
  const { rowCount: updatedCount } = await client.query(
    `
		UPDATE favorite_teams
		SET push_muted = $3
		WHERE user_id = $1 AND team_tri_code = $2 AND league = $4
		`,
    [userId, triCode, muted, league],
  );
  return updatedCount;
}

/** Sets a favorite team's tier and/or label; returns the updated row count (0 when not a favorite). */
async function updateFavoriteTeamCategory(
  client,
  { userId, triCode, league, changeTier, tier, changeLabel, label },
) {
  const { rowCount: updatedRowCount } = await client.query(
    `
		UPDATE favorite_teams
		SET tier = CASE WHEN $3::boolean THEN $4::text ELSE tier END,
			label = CASE WHEN $5::boolean THEN $6::text ELSE label END
		WHERE user_id = $1 AND team_tri_code = $2 AND league = $7
		`,
    [userId, triCode, changeTier, tier, changeLabel, label, league],
  );
  return updatedRowCount;
}

module.exports = {
  updateFavoriteTeamCategory,
  updateFavoritePushMuted,
  listFavoriteTeams,
  insertFavoriteTeam,
  deleteFavoriteTeam,
  listReadGameIds,
  insertReadGameIds,
};
