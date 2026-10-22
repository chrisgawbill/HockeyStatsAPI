/**
 * Upserts a user row keyed on the Google `sub` claim. Updates the stored
 * email when it has changed (Google accounts can change their primary
 * email address). The email arrives already encrypted, with its lookup hash;
 * any leftover plaintext `email` is cleared. Returns the full row, including
 * `id` — either the newly inserted row or the pre-existing one.
 */
async function upsertUserByGoogleSub(
  client,
  { googleSub, emailEncrypted, emailLookup },
) {
  const { rows: upsertedUserRows } = await client.query(
    `
		INSERT INTO users (google_sub, email_encrypted, email_lookup)
		VALUES ($1, $2, $3)
		ON CONFLICT (google_sub)
		DO UPDATE SET
			email_encrypted = EXCLUDED.email_encrypted,
			email_lookup = EXCLUDED.email_lookup,
			email = NULL
		RETURNING *
		`,
    [googleSub, emailEncrypted ?? null, emailLookup ?? null],
  );
  return upsertedUserRows[0];
}

/**
 * Upserts a user row keyed on the Discord user id, storing the encrypted
 * email the same way the Google upsert does. Returns the full row.
 */
async function upsertUserByDiscordId(
  client,
  { discordId, emailEncrypted, emailLookup },
) {
  const { rows: upsertedUserRows } = await client.query(
    `
		INSERT INTO users (discord_id, email_encrypted, email_lookup)
		VALUES ($1, $2, $3)
		ON CONFLICT (discord_id)
		DO UPDATE SET
			email_encrypted = EXCLUDED.email_encrypted,
			email_lookup = EXCLUDED.email_lookup,
			email = NULL
		RETURNING *
		`,
    [discordId, emailEncrypted ?? null, emailLookup ?? null],
  );
  return upsertedUserRows[0];
}

/** Fetches a user by id, or null. */
async function getUserById(client, userId) {
  const { rows: userRows } = await client.query(
    'SELECT * FROM users WHERE id = $1',
    [userId],
  );
  return userRows[0] ?? null;
}

module.exports = {
  upsertUserByGoogleSub,
  upsertUserByDiscordId,
  getUserById,
};
