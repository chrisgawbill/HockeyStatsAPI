/**
 * Upserts a user row keyed on the Google `sub` claim. Updates the stored
 * email when it has changed (Google accounts can change their primary
 * email address). Returns the full row, including `id` — either the newly
 * inserted row or the pre-existing one.
 */
async function upsertUserByGoogleSub(client, { googleSub, email }) {
  const result = await client.query(
    `
		INSERT INTO users (google_sub, email)
		VALUES ($1, $2)
		ON CONFLICT (google_sub)
		DO UPDATE SET email = EXCLUDED.email
		RETURNING *
		`,
    [googleSub, email ?? null],
  );
  return result.rows[0];
}

async function getUserById(client, userId) {
  const result = await client.query('SELECT * FROM users WHERE id = $1', [
    userId,
  ]);
  return result.rows[0] ?? null;
}

module.exports = {
  upsertUserByGoogleSub,
  getUserById,
};
