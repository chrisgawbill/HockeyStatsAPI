#!/usr/bin/env node
require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});

const { Client } = require('pg');
const { getSslConfig } = require('#platform/connectionConfig.js');
const { decryptEmail } = require('#platform/emailCrypto.js');

/**
 * Reverts migration 009 in one transaction: restores `users.google_sub`,
 * `users.discord_id` and plaintext `users.email` (decrypted from
 * `email_encrypted`, so EMAIL_ENCRYPTION_KEY is needed when any email is
 * stored), their 002/007 constraints and the non-unique lookup index, then
 * drops `user_identities` and forgets that 009 ran. A user holding two
 * identities of one provider keeps the oldest. Lookups cleared by 009's
 * duplicate resolution stay NULL.
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 */
async function rollback009(client) {
  await client.query('BEGIN');
  try {
    await client.query(`
			ALTER TABLE users
				ADD COLUMN IF NOT EXISTS google_sub text,
				ADD COLUMN IF NOT EXISTS discord_id text,
				ADD COLUMN IF NOT EXISTS email text
		`);
    await client.query(`
			UPDATE users SET
				google_sub = (
					SELECT subject FROM user_identities
					WHERE user_id = users.id AND provider = 'google'
					ORDER BY id LIMIT 1
				),
				discord_id = (
					SELECT subject FROM user_identities
					WHERE user_id = users.id AND provider = 'discord'
					ORDER BY id LIMIT 1
				)
		`);
    const { rows: encryptedRows } = await client.query(
      'SELECT id, email_encrypted FROM users WHERE email_encrypted IS NOT NULL',
    );
    for (const { id, email_encrypted: emailEncrypted } of encryptedRows) {
      await client.query('UPDATE users SET email = $2 WHERE id = $1', [
        id,
        decryptEmail(emailEncrypted),
      ]);
    }
    await client.query(`
			ALTER TABLE users
				ADD CONSTRAINT users_google_sub_unique UNIQUE (google_sub),
				ADD CONSTRAINT users_discord_id_unique UNIQUE (discord_id),
				ADD CONSTRAINT users_provider_chk CHECK (google_sub IS NOT NULL OR discord_id IS NOT NULL)
		`);
    await client.query('DROP INDEX IF EXISTS users_email_lookup_unique');
    await client.query(
      'CREATE INDEX IF NOT EXISTS users_email_lookup_idx ON users (email_lookup)',
    );
    await client.query('DROP TABLE user_identities');
    await client.query('DELETE FROM schema_migrations WHERE filename = $1', [
      '009_add_user_identities.js',
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** CLI entry point: connects with CACHE_DATABASE_URL and runs the rollback. */
async function main() {
  const connectionString = process.env.CACHE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('CACHE_DATABASE_URL is required to roll back migration 009.');
  }
  const client = new Client({ connectionString, ssl: getSslConfig() });
  await client.connect();
  try {
    await rollback009(client);
    console.log('Rolled back 009_add_user_identities.js.');
  } finally {
    await client.end();
  }
}

module.exports = { rollback009 };

if (require.main === module) {
  main().catch((error) => {
    console.error('Rollback failed:', error.message);
    process.exitCode = 1;
  });
}
