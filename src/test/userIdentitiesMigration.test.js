const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const emailCrypto = require('#platform/emailCrypto.js');
const { up } = require('#platform/migrations/009_add_user_identities.js');
const { rollback009 } = require('../../bin/rollback-009.js');

function setEmailKeys() {
  process.env.EMAIL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.EMAIL_LOOKUP_KEY = crypto.randomBytes(32).toString('base64');
}

// Records every statement; `rowsFor` answers SELECTs whose SQL contains a key.
function makeFakeClient(rowsFor = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const key = Object.keys(rowsFor).find((fragment) => sql.includes(fragment));
      return { rows: key ? rowsFor[key] : [] };
    },
  };
}

const PLAINTEXT_SELECT = 'SELECT id, email FROM users WHERE email IS NOT NULL';

test('migration 009 copies identities, encrypts leftover plaintext, resolves duplicate lookups and drops the old columns', async () => {
  setEmailKeys();
  const client = makeFakeClient({
    [PLAINTEXT_SELECT]: [{ id: 3, email: 'Fan@Example.com' }],
  });
  await up(client);
  const sqls = client.calls.map(({ sql }) => sql);
  const indexOf = (pattern) => sqls.findIndex((sql) => pattern.test(sql));

  assert.ok(indexOf(/^CREATE TABLE IF NOT EXISTS user_identities .*UNIQUE \(provider, subject\)/) === 0);
  assert.ok(indexOf(/CREATE INDEX IF NOT EXISTS user_identities_user_id_idx ON user_identities \(user_id\)/) > 0);
  assert.ok(indexOf(/INSERT INTO user_identities .*'google', google_sub FROM users WHERE google_sub IS NOT NULL/) > 0);
  assert.ok(indexOf(/INSERT INTO user_identities .*'discord', discord_id FROM users WHERE discord_id IS NOT NULL/) > 0);

  const encrypt = client.calls.find(({ sql }) => sql.includes('email = NULL'));
  assert.equal(encrypt.params[0], 3);
  assert.ok(!encrypt.params[1].includes('Example'));
  assert.equal(emailCrypto.decryptEmail(encrypt.params[1]), 'Fan@Example.com');
  assert.equal(encrypt.params[2], emailCrypto.hashEmailForLookup('fan@example.com'));

  const dedupe = indexOf(/SET email_lookup = NULL .*earlier\.id < users\.id/);
  const unique = indexOf(/CREATE UNIQUE INDEX IF NOT EXISTS users_email_lookup_unique ON users \(email_lookup\) WHERE email_lookup IS NOT NULL/);
  assert.ok(client.calls.indexOf(encrypt) < dedupe);
  assert.ok(dedupe < indexOf(/DROP INDEX IF EXISTS users_email_lookup_idx/));
  assert.ok(dedupe < unique);

  const drop = sqls[sqls.length - 1];
  for (const fragment of [
    'DROP CONSTRAINT IF EXISTS users_provider_chk',
    'DROP CONSTRAINT IF EXISTS users_google_sub_unique',
    'DROP CONSTRAINT IF EXISTS users_discord_id_unique',
    'DROP COLUMN IF EXISTS email,',
    'DROP COLUMN IF EXISTS google_sub',
    'DROP COLUMN IF EXISTS discord_id',
  ]) {
    assert.ok(drop.includes(fragment), fragment);
  }
});

test('migration 009 needs no keys when no plaintext is left', async () => {
  delete process.env.EMAIL_ENCRYPTION_KEY;
  delete process.env.EMAIL_LOOKUP_KEY;
  const client = makeFakeClient();
  await up(client);
  assert.ok(!client.calls.some(({ sql }) => sql.includes('email = NULL')));
});

test('migration 009 fails with a key error that never names the email when plaintext exists without keys', async () => {
  delete process.env.EMAIL_ENCRYPTION_KEY;
  process.env.EMAIL_LOOKUP_KEY = crypto.randomBytes(32).toString('base64');
  const client = makeFakeClient({
    [PLAINTEXT_SELECT]: [{ id: 1, email: 'secret@example.com' }],
  });
  await assert.rejects(up(client), (error) => {
    assert.match(error.message, /EMAIL_ENCRYPTION_KEY and EMAIL_LOOKUP_KEY are required/);
    assert.ok(!error.message.includes('secret@example.com'));
    return true;
  });
  assert.ok(!client.calls.some(({ sql }) => sql.includes('DROP COLUMN')));
});

test('rollback-009 restores the old columns, constraints and index, drops user_identities and forgets 009', async () => {
  setEmailKeys();
  const encrypted = emailCrypto.encryptEmail('fan@example.com');
  const client = makeFakeClient({
    'SELECT id, email_encrypted': [{ id: 5, email_encrypted: encrypted }],
  });
  await rollback009(client);
  const sqls = client.calls.map(({ sql }) => sql);

  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /ADD COLUMN IF NOT EXISTS google_sub text, ADD COLUMN IF NOT EXISTS discord_id text, ADD COLUMN IF NOT EXISTS email text/);
  assert.match(sqls[2], /google_sub = \( SELECT subject FROM user_identities WHERE user_id = users\.id AND provider = 'google'/);
  assert.match(sqls[2], /discord_id = \( SELECT subject FROM user_identities WHERE user_id = users\.id AND provider = 'discord'/);
  const restoreEmail = client.calls.find(({ sql }) => sql.startsWith('UPDATE users SET email = $2'));
  assert.deepEqual(restoreEmail.params, [5, 'fan@example.com']);
  const constraints = sqls.find((sql) => sql.includes('ADD CONSTRAINT'));
  assert.match(constraints, /users_google_sub_unique UNIQUE \(google_sub\)/);
  assert.match(constraints, /users_discord_id_unique UNIQUE \(discord_id\)/);
  assert.match(constraints, /users_provider_chk CHECK \(google_sub IS NOT NULL OR discord_id IS NOT NULL\)/);
  assert.ok(sqls.includes('DROP INDEX IF EXISTS users_email_lookup_unique'));
  assert.ok(sqls.includes('CREATE INDEX IF NOT EXISTS users_email_lookup_idx ON users (email_lookup)'));
  assert.ok(sqls.includes('DROP TABLE user_identities'));
  const forget = client.calls.find(({ sql }) => sql.startsWith('DELETE FROM schema_migrations'));
  assert.deepEqual(forget.params, ['009_add_user_identities.js']);
  assert.equal(sqls[sqls.length - 1], 'COMMIT');
});

test('rollback-009 rolls back when a step fails', async () => {
  const client = makeFakeClient();
  const original = client.query;
  client.query = async (sql, params) => {
    if (sql.includes('DROP TABLE')) {
      throw new Error('boom');
    }
    return original(sql, params);
  };
  await assert.rejects(rollback009(client), /boom/);
  const sqls = client.calls.map(({ sql }) => sql);
  assert.equal(sqls[sqls.length - 1], 'ROLLBACK');
  assert.ok(!sqls.includes('COMMIT'));
});
