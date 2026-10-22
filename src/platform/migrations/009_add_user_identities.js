const { protectEmail } = require('#platform/emailCrypto.js');

/**
 * Moves sign-in identities into `user_identities` (provider, subject) -> user,
 * so one account can hold both a Google and a Discord identity. User ids are
 * kept, so favorites, push subscriptions, streaks and reports stay attached.
 * Also encrypts any plaintext `users.email` left from before migration 008,
 * makes `email_lookup` unique (the lowest user id keeps a shared lookup; the
 * others keep only their encrypted email) and drops `users.email`,
 * `users.google_sub` and `users.discord_id`. Runs inside the migration
 * runner's transaction. Roll back with `node bin/rollback-009.js`.
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 */
async function up(client) {
  await client.query(`
		CREATE TABLE IF NOT EXISTS user_identities (
			id bigserial PRIMARY KEY,
			user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
			provider text NOT NULL CHECK (provider IN ('google', 'discord')),
			subject text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			last_signed_in_at timestamptz NOT NULL DEFAULT now(),
			CONSTRAINT user_identities_provider_subject_unique UNIQUE (provider, subject)
		)
	`);
  await client.query(
    'CREATE INDEX IF NOT EXISTS user_identities_user_id_idx ON user_identities (user_id)',
  );

  await client.query(`
		INSERT INTO user_identities (user_id, provider, subject)
		SELECT id, 'google', google_sub FROM users WHERE google_sub IS NOT NULL
		ON CONFLICT (provider, subject) DO NOTHING
	`);
  await client.query(`
		INSERT INTO user_identities (user_id, provider, subject)
		SELECT id, 'discord', discord_id FROM users WHERE discord_id IS NOT NULL
		ON CONFLICT (provider, subject) DO NOTHING
	`);

  const { rows: plaintextRows } = await client.query(
    'SELECT id, email FROM users WHERE email IS NOT NULL FOR UPDATE',
  );
  if (
    plaintextRows.length > 0 &&
    (!process.env.EMAIL_ENCRYPTION_KEY || !process.env.EMAIL_LOOKUP_KEY)
  ) {
    throw new Error(
      `EMAIL_ENCRYPTION_KEY and EMAIL_LOOKUP_KEY are required to encrypt ${plaintextRows.length} stored email(s).`,
    );
  }
  for (const { id, email } of plaintextRows) {
    const { emailEncrypted, emailLookup } = protectEmail(email);
    await client.query(
      `UPDATE users
			SET email_encrypted = $2, email_lookup = $3, email = NULL
			WHERE id = $1`,
      [id, emailEncrypted, emailLookup],
    );
  }

  await client.query(`
		UPDATE users
		SET email_lookup = NULL
		WHERE email_lookup IS NOT NULL
			AND EXISTS (
				SELECT 1 FROM users AS earlier
				WHERE earlier.email_lookup = users.email_lookup
					AND earlier.id < users.id
			)
	`);
  await client.query('DROP INDEX IF EXISTS users_email_lookup_idx');
  await client.query(`
		CREATE UNIQUE INDEX IF NOT EXISTS users_email_lookup_unique
		ON users (email_lookup)
		WHERE email_lookup IS NOT NULL
	`);

  await client.query(`
		ALTER TABLE users
			DROP CONSTRAINT IF EXISTS users_provider_chk,
			DROP CONSTRAINT IF EXISTS users_google_sub_unique,
			DROP CONSTRAINT IF EXISTS users_discord_id_unique,
			DROP COLUMN IF EXISTS email,
			DROP COLUMN IF EXISTS google_sub,
			DROP COLUMN IF EXISTS discord_id
	`);
}

module.exports = { up };
