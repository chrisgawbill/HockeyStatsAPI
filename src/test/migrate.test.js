const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIGRATION_LOCK_ID,
  applyPendingMigrations,
  runMigrations,
  shouldSkip,
} = require('#platform/migrate.js');

function makeMigrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

// Records every query; `failOn` makes a matching statement throw.
function makeFakeClient({ applied = [], failOn } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.trim(), params });
      if (failOn && sql.includes(failOn)) {
        throw new Error('boom');
      }
      if (sql.includes('SELECT filename')) {
        return { rows: applied.map((filename) => ({ filename })) };
      }
      return { rows: [] };
    },
  };
}

const statements = (client) => client.calls.map((c) => c.sql);
const quiet = () => {};

test('shouldSkip only skips with --if-configured and no URL', () => {
  assert.equal(shouldSkip(['--if-configured'], {}), true);
  assert.equal(shouldSkip(['--if-configured'], { CACHE_DATABASE_URL: '' }), true);
  assert.equal(
    shouldSkip(['--if-configured'], { CACHE_DATABASE_URL: 'postgres://x' }),
    false,
  );
  assert.equal(shouldSkip([], {}), false);
});

test('runMigrations without a URL fails loudly', async () => {
  await assert.rejects(() => runMigrations({}), /CACHE_DATABASE_URL is required/);
});

test('applies only pending migrations in filename order', async () => {
  const dir = makeMigrationsDir({
    '003_c.sql': 'SQL_C',
    '001_a.sql': 'SQL_A',
    '002_b.sql': 'SQL_B',
    'notes.txt': 'ignored',
  });
  const client = makeFakeClient({ applied: ['001_a.sql'] });
  const result = await applyPendingMigrations(client, {
    migrationsDir: dir,
    log: quiet,
  });

  assert.deepEqual(result, ['002_b.sql', '003_c.sql']);
  const sqls = statements(client);
  assert.ok(!sqls.includes('SQL_A'));
  assert.ok(sqls.indexOf('SQL_B') < sqls.indexOf('SQL_C'));
  const inserts = client.calls
    .filter((c) => c.sql.startsWith('INSERT INTO schema_migrations'))
    .map((c) => c.params[0]);
  assert.deepEqual(inserts, ['002_b.sql', '003_c.sql']);
});

test('reports no pending migrations', async () => {
  const dir = makeMigrationsDir({ '001_a.sql': 'SQL_A' });
  const client = makeFakeClient({ applied: ['001_a.sql'] });
  const logs = [];
  const result = await applyPendingMigrations(client, {
    migrationsDir: dir,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, []);
  assert.deepEqual(logs, ['No pending migrations.']);
});

test('failed migration rolls back, rethrows and stops', async () => {
  const dir = makeMigrationsDir({
    '001_a.sql': 'SQL_A',
    '002_b.sql': 'SQL_B',
  });
  const client = makeFakeClient({ failOn: 'SQL_A' });
  await assert.rejects(
    () => applyPendingMigrations(client, { migrationsDir: dir, log: quiet }),
    /boom/,
  );
  const sqls = statements(client);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(!sqls.includes('COMMIT'));
  assert.ok(!sqls.includes('SQL_B'));
});

test('advisory lock is taken first and released on success', async () => {
  const dir = makeMigrationsDir({ '001_a.sql': 'SQL_A' });
  const client = makeFakeClient();
  await applyPendingMigrations(client, { migrationsDir: dir, log: quiet });

  const first = client.calls[0];
  const last = client.calls[client.calls.length - 1];
  assert.match(first.sql, /pg_advisory_lock/);
  assert.deepEqual(first.params, [MIGRATION_LOCK_ID]);
  assert.match(last.sql, /pg_advisory_unlock/);
  assert.deepEqual(last.params, [MIGRATION_LOCK_ID]);
});

test('advisory lock is released when a migration fails', async () => {
  const dir = makeMigrationsDir({ '001_a.sql': 'SQL_A' });
  const client = makeFakeClient({ failOn: 'SQL_A' });
  await assert.rejects(() =>
    applyPendingMigrations(client, { migrationsDir: dir, log: quiet }),
  );
  const last = client.calls[client.calls.length - 1];
  assert.match(last.sql, /pg_advisory_unlock/);
});

test('runMigrations connects with the given ssl and always ends the client', async () => {
  const dir = makeMigrationsDir({ '001_a.sql': 'SQL_A' });
  const client = makeFakeClient({ failOn: 'SQL_A' });
  let options;
  let ended = false;
  client.connect = async () => {};
  client.end = async () => {
    ended = true;
  };
  const ssl = { rejectUnauthorized: true };
  await assert.rejects(() =>
    runMigrations({
      connectionString: 'postgres://x',
      ssl,
      migrationsDir: dir,
      log: quiet,
      createClient: (o) => {
        options = o;
        return client;
      },
    }),
  );
  assert.deepEqual(options, { connectionString: 'postgres://x', ssl });
  assert.equal(ended, true);
});
