const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');
const jwt = require('jsonwebtoken');

const { makeTestApp, request } = require('./testApp.js');
const { requireAuth } = require('#presentation/middleware/requireAuth.js');
const { createBoardGameRouter } = require('#presentation/routes/boardGame.js');

const SECRET = 'test-session-secret';

beforeEach(() => {
  process.env.SESSION_JWT_SECRET = SECRET;
});

function validToken(userId = 'user-1') {
  return jwt.sign({ userId }, SECRET, { expiresIn: '30d' });
}

function expiredToken(userId = 'user-1') {
  return jwt.sign(
    { userId, exp: Math.floor(Date.now() / 1000) - 60 },
    SECRET,
  );
}

function buildProtectedApp() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.get('/protected', requireAuth, (req, res) =>
    res.send({ userId: req.userId }),
  );
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  return app;
}

test('requireAuth rejects missing, malformed, and expired tokens and attaches req.userId', async () => {
  const app = buildProtectedApp();
  const missing = await request(app, '/protected');
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { error: 'Unauthorized' });

  for (const token of ['not-a-real-jwt', expiredToken()]) {
    const response = await request(app, '/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 401);
  }

  const ok = await request(app, '/protected', {
    headers: { authorization: `Bearer ${validToken('user-42')}` },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.userId, 'user-42');
});

test('board-game /streak requires a session and passes req.userId to the service', async () => {
  let calledWith = null;
  const app = makeTestApp(
    '/api/board-game',
    createBoardGameRouter({
      boardGameStreakService: {
        getStreakForUser: async (userId) => {
          calledWith = userId;
          return { wins: { '2026-01-01': true }, lastWinDate: '2026-01-01' };
        },
        putStreakForUser: async () => {
          throw new Error('should not be called without auth');
        },
      },
    }),
  );

  assert.equal((await request(app, '/api/board-game/streak')).status, 401);
  const put = await request(app, '/api/board-game/streak', {
    method: 'PUT',
    body: JSON.stringify({ wins: {}, lastWinDate: null }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(put.status, 401);
  assert.equal(calledWith, null);

  const response = await request(app, '/api/board-game/streak', {
    headers: { authorization: `Bearer ${validToken('user-7')}` },
  });
  assert.equal(response.status, 200);
  assert.equal(calledWith, 'user-7');
  assert.deepEqual(response.body, {
    wins: { '2026-01-01': true },
    lastWinDate: '2026-01-01',
  });
});

// --- Discord sign-in: the service against a fake Discord client and a fake
// SQL client, and the route against a fake service.

const crypto = require('crypto');
const emailCrypto = require('#platform/emailCrypto.js');
const { createAuthService } = require('#slices/auth/authService.js');
const { createAuthRouter } = require('#presentation/routes/auth.js');
const { jsonRequest } = require('./testApp.js');

const ALLOWED_REDIRECT = 'http://localhost:5173/HockeyStatsWebApp/';

function setEmailKeys() {
  process.env.EMAIL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.EMAIL_LOOKUP_KEY = crypto.randomBytes(32).toString('base64');
}

function buildDiscordAuthService(discordUser) {
  const queries = [];
  const discordCalls = [];
  const service = createAuthService({
    withTransaction: (fn) =>
      fn({
        query: async (sql, params) => {
          queries.push({ sql, params });
          return {
            rows: [{ id: 99, discord_id: params[0], email_encrypted: params[1] }],
          };
        },
      }),
    googleAuth: {},
    emailCrypto,
    discordAuth: {
      getAllowedRedirectUris: () => [ALLOWED_REDIRECT],
      verifyDiscordCode: async (params) => {
        discordCalls.push(params);
        if (discordUser instanceof Error) {
          throw discordUser;
        }
        return discordUser;
      },
    },
    sessionJwt: { signSessionToken: ({ userId }) => `session-for-${userId}` },
  });
  return { service, queries, discordCalls };
}

test('signInWithDiscord upserts by Discord id with an encrypted email and issues a session token', async () => {
  setEmailKeys();
  const { service, queries, discordCalls } = buildDiscordAuthService({
    id: '123456',
    email: 'fan@example.com',
    verified: true,
  });

  const result = await service.signInWithDiscord({
    code: 'auth-code',
    redirectUri: ALLOWED_REDIRECT,
  });

  assert.deepEqual(result, { token: 'session-for-99', email: 'fan@example.com' });
  assert.deepEqual(discordCalls, [
    { code: 'auth-code', redirectUri: ALLOWED_REDIRECT },
  ]);
  assert.match(queries[0].sql, /ON CONFLICT \(discord_id\)/);
  const [discordId, emailEncrypted, emailLookup] = queries[0].params;
  assert.equal(discordId, '123456');
  assert.ok(!emailEncrypted.includes('fan@example.com'));
  assert.equal(emailCrypto.decryptEmail(emailEncrypted), 'fan@example.com');
  assert.equal(emailLookup, emailCrypto.hashEmailForLookup('fan@example.com'));
});

test('signInWithDiscord drops an email Discord has not verified', async () => {
  const { service, queries } = buildDiscordAuthService({
    id: '123456',
    email: 'unverified@example.com',
    verified: false,
  });

  const result = await service.signInWithDiscord({
    code: 'auth-code',
    redirectUri: ALLOWED_REDIRECT,
  });

  assert.equal(result.email, null);
  assert.deepEqual(queries[0].params, ['123456', null, null]);
});

test('signInWithDiscord rejects a missing code or an unlisted redirectUri before calling Discord', async () => {
  const { service, discordCalls } = buildDiscordAuthService({ id: '1' });

  for (const params of [
    { redirectUri: ALLOWED_REDIRECT },
    { code: 'auth-code' },
    { code: 'auth-code', redirectUri: 'https://evil.example/' },
  ]) {
    await assert.rejects(service.signInWithDiscord(params), { status: 400 });
  }
  assert.equal(discordCalls.length, 0);
});

test('signInWithDiscord returns 401 when Discord rejects the code', async () => {
  const { service, queries } = buildDiscordAuthService(
    new Error('invalid_grant'),
  );

  await assert.rejects(
    service.signInWithDiscord({ code: 'bad', redirectUri: ALLOWED_REDIRECT }),
    { status: 401 },
  );
  assert.equal(queries.length, 0);
});

test('POST /api/auth/discord passes code and redirectUri to the service', async () => {
  let calledWith = null;
  const app = makeTestApp(
    '/api/auth',
    createAuthRouter({
      authService: {
        signInWithDiscord: async (params) => {
          calledWith = params;
          return { token: 'session-token', email: null };
        },
      },
    }),
  );

  const response = await jsonRequest(app, '/api/auth/discord', {
    method: 'POST',
    body: JSON.stringify({ code: 'auth-code', redirectUri: ALLOWED_REDIRECT }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { token: 'session-token', email: null });
  assert.deepEqual(calledWith, {
    code: 'auth-code',
    redirectUri: ALLOWED_REDIRECT,
  });
});

// --- Email encryption.

test('encryptEmail round-trips and never repeats a ciphertext', () => {
  setEmailKeys();
  const first = emailCrypto.encryptEmail('Fan@Example.com');
  const second = emailCrypto.encryptEmail('Fan@Example.com');
  assert.notEqual(first, second);
  assert.match(first, /^v1:/);
  assert.equal(emailCrypto.decryptEmail(first), 'Fan@Example.com');
});

test('decryptEmail rejects a tampered ciphertext or a different key', () => {
  setEmailKeys();
  const encrypted = emailCrypto.encryptEmail('fan@example.com');
  const [version, iv, tag, ciphertext] = encrypted.split(':');
  const flipped = Buffer.from(ciphertext, 'base64');
  flipped[0] ^= 1;
  assert.throws(() =>
    emailCrypto.decryptEmail(
      [version, iv, tag, flipped.toString('base64')].join(':'),
    ),
  );

  setEmailKeys();
  assert.throws(() => emailCrypto.decryptEmail(encrypted));
});

test('hashEmailForLookup ignores case and whitespace but depends on the key', () => {
  setEmailKeys();
  const hash = emailCrypto.hashEmailForLookup('fan@example.com');
  assert.equal(emailCrypto.hashEmailForLookup('  FAN@Example.COM '), hash);
  assert.notEqual(emailCrypto.hashEmailForLookup('other@example.com'), hash);

  setEmailKeys();
  assert.notEqual(emailCrypto.hashEmailForLookup('fan@example.com'), hash);
});

test('email crypto fails loudly on a missing or wrong-length key', () => {
  delete process.env.EMAIL_ENCRYPTION_KEY;
  assert.throws(() => emailCrypto.encryptEmail('a@b.c'), /EMAIL_ENCRYPTION_KEY is required/);
  process.env.EMAIL_LOOKUP_KEY = Buffer.alloc(16).toString('base64');
  assert.throws(() => emailCrypto.hashEmailForLookup('a@b.c'), /must be 32 bytes/);
  assert.deepEqual(emailCrypto.protectEmail(null), {
    emailEncrypted: null,
    emailLookup: null,
  });
});

test('encryptStoredEmails encrypts plaintext rows and clears the plaintext', async () => {
  setEmailKeys();
  const { encryptStoredEmails } = require('#platform/encryptStoredEmails.js');
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) {
        return { rows: [{ id: 1, email: 'fan@example.com' }] };
      }
      return { rows: [] };
    },
  };

  assert.equal(await encryptStoredEmails(client, { log: () => {} }), 1);
  const update = calls.find(({ sql }) => sql.startsWith('UPDATE'));
  assert.match(update.sql, /email = NULL/);
  assert.equal(update.params[0], 1);
  assert.equal(emailCrypto.decryptEmail(update.params[1]), 'fan@example.com');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
