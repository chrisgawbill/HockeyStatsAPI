require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env'),
});

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const migrationsDir = path.join(__dirname, 'migrations');

function getPool() {
  if (!process.env.CACHE_DATABASE_URL) {
    throw new Error(
      'CACHE_DATABASE_URL is required to run database migrations.',
    );
  }
  return new Pool({
    connectionString: process.env.CACHE_DATABASE_URL,
    ssl:
      process.env.CACHE_DATABASE_SSL === 'false'
        ? false
        : process.env.NODE_ENV === 'production' ||
            process.env.CACHE_DATABASE_SSL === 'true'
          ? { rejectUnauthorized: false }
          : undefined,
  });
}

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

function getMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function runMigration(client, filename) {
  const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
      filename,
    ]);
    await client.query('COMMIT');
    console.log(`Applied ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const pending = getMigrationFiles().filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const filename of pending) {
      await runMigration(client, filename);
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
