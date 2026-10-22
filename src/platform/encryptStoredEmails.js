require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env'),
});

const { Client } = require('pg');
const {
  getDatabaseUrl,
  getSslConfig,
} = require('#platform/connectionConfig.js');
const { protectEmail } = require('#platform/emailCrypto.js');

/**
 * Encrypts any plaintext `users.email` left from before migration 008 and
 * clears the plaintext, in one transaction. Idempotent: once every row is
 * encrypted it finds nothing to do, and it needs no keys in that case.
 * @returns {Promise<number>} the number of rows encrypted
 */
async function encryptStoredEmails(client, { log = console.log } = {}) {
  await client.query('BEGIN');
  try {
    const { rows: plaintextRows } = await client.query(
      'SELECT id, email FROM users WHERE email IS NOT NULL FOR UPDATE',
    );
    for (const { id, email } of plaintextRows) {
      const { emailEncrypted, emailLookup } = protectEmail(email);
      await client.query(
        `UPDATE users
				SET email_encrypted = $2, email_lookup = $3, email = NULL
				WHERE id = $1`,
        [id, emailEncrypted, emailLookup],
      );
    }
    await client.query('COMMIT');
    if (plaintextRows.length > 0) {
      log(`Encrypted ${plaintextRows.length} stored email(s).`);
    }
    return plaintextRows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** CLI entry point; with --if-configured, a missing database URL means there is nothing to encrypt. */
async function main(argv = process.argv.slice(2)) {
  const connectionString = getDatabaseUrl();
  if (argv.includes('--if-configured') && !connectionString) {
    console.log('Skipping email encryption: no database URL is set.');
    return;
  }
  if (!connectionString) {
    throw new Error('DATABASE_URL or CACHE_DATABASE_URL is required.');
  }
  const client = new Client({ connectionString, ssl: getSslConfig() });
  await client.connect();
  try {
    await encryptStoredEmails(client);
  } finally {
    await client.end();
  }
}

module.exports = { encryptStoredEmails, main };

if (require.main === module) {
  main().catch((error) => {
    console.error('Email encryption failed:', error.message);
    process.exitCode = 1;
  });
}
