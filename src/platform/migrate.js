require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env'),
});

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { getSslConfig } = require('#platform/connectionConfig.js');

const defaultMigrationsDir = path.join(__dirname, 'migrations');

// Arbitrary fixed key for the session advisory lock that serializes migration
// runs, so instances starting together cannot apply the same migration twice.
const MIGRATION_LOCK_ID = '727274001';

async function ensureMigrationsTable(client) {
  await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((row) => row.filename));
}

function getMigrationFiles(migrationsDir) {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function runMigration(client, migrationsDir, filename, log) {
  const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
      filename,
    ]);
    await client.query('COMMIT');
    log(`Applied ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// Applies pending migrations on an already-connected client while holding the
// advisory lock. Waiting for the lock also means a second instance sees the
// first one's migrations as applied once it gets in.
async function applyPendingMigrations(
  client,
  { migrationsDir = defaultMigrationsDir, log = console.log } = {},
) {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const pending = getMigrationFiles(migrationsDir).filter(
      (file) => !applied.has(file),
    );

    if (pending.length === 0) {
      log('No pending migrations.');
      return [];
    }

    for (const filename of pending) {
      await runMigration(client, migrationsDir, filename, log);
    }
    log(`Applied ${pending.length} migration(s).`);
    return pending;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch {
      // Ignore unlock failures (e.g. dropped connection) so they do not mask
      // the migration error; closing the session releases the lock anyway.
    }
  }
}

async function runMigrations({
  connectionString,
  ssl,
  migrationsDir,
  log,
  createClient = (options) => new Client(options),
} = {}) {
  if (!connectionString) {
    throw new Error(
      'CACHE_DATABASE_URL is required to run database migrations.',
    );
  }
  const client = createClient({ connectionString, ssl });
  await client.connect();
  try {
    return await applyPendingMigrations(client, { migrationsDir, log });
  } finally {
    await client.end();
  }
}

// With --if-configured (used by `pnpm start`), a missing CACHE_DATABASE_URL
// means filesystem-cache mode, so there is nothing to migrate.
function shouldSkip(argv, env) {
  return argv.includes('--if-configured') && !env.CACHE_DATABASE_URL;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (shouldSkip(argv, env)) {
    console.log('Skipping migrations: CACHE_DATABASE_URL is not set.');
    return;
  }
  await runMigrations({
    connectionString: env.CACHE_DATABASE_URL,
    ssl: getSslConfig(),
  });
}

module.exports = {
  MIGRATION_LOCK_ID,
  applyPendingMigrations,
  runMigrations,
  shouldSkip,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  });
}
