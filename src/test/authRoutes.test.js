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

// --- Sign-in and account linking: the service against fake provider clients
// and an in-memory fake of the users/user_identities tables, and the routes
// against the real service or a fake one.

const crypto = require('crypto');
const emailCrypto = require('#platform/emailCrypto.js');
const { createAuthService } = require('#slices/auth/authService.js');
const { createAuthRouter } = require('#presentation/routes/auth.js');
const { verifyDiscordCode } = require('#platform/discordAuthClient.js');
const { jsonRequest } = require('./testApp.js');

const ALLOWED_REDIRECT = 'http://localhost:5173/HockeyStatsWebApp/';
const VERIFIER = 'a'.repeat(43);

function setEmailKeys() {
  process.env.EMAIL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.EMAIL_LOOKUP_KEY = crypto.randomBytes(32).toString('base64');
}

function uniqueViolation() {
  return Object.assign(new Error('duplicate key'), { code: '23505' });
}

// Answers the repository's statements from in-memory rows, enforcing the
// (provider, subject) and email_lookup unique indexes.
function makeFakeDb() {
  const users = [];
  const identities = [];
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push(sql);
      if (sql.includes('JOIN users')) {
        const identity = identities.find(
          (row) => row.provider === params[0] && row.subject === params[1],
        );
        return { rows: identity ? [users.find((u) => u.id === identity.user_id)] : [] };
      }
      if (sql.includes('UPDATE user_identities')) {
        return { rows: [] };
      }
      if (sql.includes('WHERE email_lookup = $1')) {
        return { rows: users.filter((u) => u.email_lookup === params[0]) };
      }
      if (sql.includes('INSERT INTO users')) {
        if (params[1] && users.some((u) => u.email_lookup === params[1])) {
          throw uniqueViolation();
        }
        const user = { id: users.length + 1, email_encrypted: params[0], email_lookup: params[1] };
        users.push(user);
        return { rows: [user] };
      }
      if (sql.includes('INSERT INTO user_identities')) {
        if (identities.some((row) => row.provider === params[1] && row.subject === params[2])) {
          throw uniqueViolation();
        }
        identities.push({ user_id: params[0], provider: params[1], subject: params[2] });
        return { rows: [] };
      }
      if (sql.includes('UPDATE users')) {
        const user = users.find((u) => u.id === params[0]);
        Object.assign(user, { email_encrypted: params[1], email_lookup: params[2] });
        return { rows: [user] };
      }
      if (sql.includes('WHERE id = $1')) {
        return { rows: users.filter((u) => u.id === params[0]) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { users, identities, statements, client };
}

function buildAuthService({ db = makeFakeDb(), googlePayload, discordUser } = {}) {
  const discordCalls = [];
  const service = createAuthService({
    withTransaction: (fn) => fn(db.client),
    googleAuth: {
      verifyGoogleIdToken: async () => {
        if (googlePayload instanceof Error) {
          throw googlePayload;
        }
        return googlePayload;
      },
    },
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
  return { service, db, discordCalls };
}

const google = (db, payload) =>
  buildAuthService({ db, googlePayload: payload }).service.signInWithGoogle('cred');
const discord = (db, discordUser) =>
  buildAuthService({ db, discordUser }).service.signInWithDiscord({
    code: 'auth-code',
    codeVerifier: VERIFIER,
    redirectUri: ALLOWED_REDIRECT,
  });

test('verified Google and verified Discord with the same email share one account', async () => {
  setEmailKeys();
  const db = makeFakeDb();
  const first = await google(db, { sub: 'g-1', email: 'Fan@Example.com', email_verified: true });
  const second = await discord(db, { id: 'd-1', email: 'fan@example.com', verified: true });

  assert.deepEqual(first, { token: 'session-for-1', email: 'Fan@Example.com' });
  assert.equal(second.token, 'session-for-1');
  assert.equal(db.users.length, 1);
  assert.deepEqual(
    db.identities.map(({ user_id, provider }) => [user_id, provider]),
    [[1, 'google'], [1, 'discord']],
  );
  assert.ok(!db.users[0].email_encrypted.includes('example.com'));
  assert.equal(db.users[0].email_lookup, emailCrypto.hashEmailForLookup('fan@example.com'));
});

test('an unverified Discord email is never stored or linked', async () => {
  setEmailKeys();
  const db = makeFakeDb();
  await google(db, { sub: 'g-1', email: 'fan@example.com', email_verified: true });
  const result = await discord(db, { id: 'd-1', email: 'fan@example.com', verified: false });

  assert.deepEqual(result, { token: 'session-for-2', email: null });
  assert.deepEqual(db.users[1], { id: 2, email_encrypted: null, email_lookup: null });
});

test('an unverified Google email gets a new account with no lookup that verified Discord cannot link to', async () => {
  setEmailKeys();
  const db = makeFakeDb();
  const first = await google(db, { sub: 'g-1', email: 'fan@example.com', email_verified: false });
  assert.equal(first.email, 'fan@example.com');
  assert.equal(db.users[0].email_lookup, null);

  const second = await discord(db, { id: 'd-1', email: 'fan@example.com', verified: true });
  assert.equal(second.token, 'session-for-2');
  assert.equal(db.users.length, 2);
  assert.equal(db.users[1].email_lookup, emailCrypto.hashEmailForLookup('fan@example.com'));
});

test('a returning identity signs in as its own user and touches last_signed_in_at', async () => {
  setEmailKeys();
  const db = makeFakeDb();
  await discord(db, { id: 'd-1', email: 'a@example.com', verified: true });
  await google(db, { sub: 'g-1', email: 'b@example.com', email_verified: true });
  db.statements.length = 0;

  const again = await discord(db, { id: 'd-1', email: 'a@example.com', verified: true });
  assert.deepEqual(again, { token: 'session-for-1', email: 'a@example.com' });
  assert.ok(db.statements.some((sql) => sql.includes('SET last_signed_in_at = now()')));
  assert.equal(db.users.length, 2);
  assert.equal(db.identities.length, 2);
});

test('a verified email change updates the account unless another user holds that email', async () => {
  setEmailKeys();
  const db = makeFakeDb();
  await google(db, { sub: 'g-1', email: 'old@example.com', email_verified: true });
  await google(db, { sub: 'g-2', email: 'taken@example.com', email_verified: true });

  const changed = await google(db, { sub: 'g-1', email: 'new@example.com', email_verified: true });
  assert.equal(changed.email, 'new@example.com');
  assert.equal(db.users[0].email_lookup, emailCrypto.hashEmailForLookup('new@example.com'));

  const blocked = await google(db, { sub: 'g-1', email: 'taken@example.com', email_verified: true });
  assert.equal(blocked.email, 'new@example.com');
  assert.equal(blocked.token, 'session-for-1');

  const unverified = await google(db, { sub: 'g-1', email: 'other@example.com', email_verified: false });
  assert.equal(unverified.email, 'new@example.com');
  assert.equal(db.users[0].email_lookup, emailCrypto.hashEmailForLookup('new@example.com'));
});

test('a unique-index race is retried once in a fresh transaction', async () => {
  setEmailKeys();
  const db = makeFakeDb();
  let attempts = 0;
  const service = createAuthService({
    withTransaction: (fn) => {
      attempts += 1;
      return fn(db.client);
    },
    googleAuth: {},
    emailCrypto,
    discordAuth: {
      getAllowedRedirectUris: () => [ALLOWED_REDIRECT],
      verifyDiscordCode: async () => ({ id: 'd-1', email: null, verified: false }),
    },
    sessionJwt: { signSessionToken: ({ userId }) => `session-for-${userId}` },
  });
  // The first attempt sees no identity, then a concurrent sign-in for the
  // same identity commits before its insert hits the unique index.
  const original = db.client.query;
  let firstLookup = true;
  db.client.query = async (sql, params) => {
    if (firstLookup && sql.includes('JOIN users')) {
      firstLookup = false;
      db.users.push({ id: 7, email_encrypted: null, email_lookup: null });
      db.identities.push({ user_id: 7, provider: 'discord', subject: 'd-1' });
      return { rows: [] };
    }
    return original(sql, params);
  };

  const result = await service.signInWithDiscord({
    code: 'auth-code',
    codeVerifier: VERIFIER,
    redirectUri: ALLOWED_REDIRECT,
  });
  assert.equal(attempts, 2);
  assert.equal(result.token, 'session-for-7');
});

test('signInWithDiscord rejects a missing code, bad codeVerifier or unlisted redirectUri before calling Discord', async () => {
  const { service, discordCalls } = buildAuthService({ discordUser: { id: '1' } });

  for (const params of [
    { codeVerifier: VERIFIER, redirectUri: ALLOWED_REDIRECT },
    { code: 'auth-code', codeVerifier: VERIFIER },
    { code: 'auth-code', codeVerifier: VERIFIER, redirectUri: 'https://evil.example/' },
  ]) {
    await assert.rejects(service.signInWithDiscord(params), { status: 400 });
  }
  for (const codeVerifier of [undefined, 'a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}+`, 42]) {
    await assert.rejects(
      service.signInWithDiscord({ code: 'auth-code', codeVerifier, redirectUri: ALLOWED_REDIRECT }),
      { status: 400, message: 'codeVerifier is required.' },
    );
  }
  assert.equal(discordCalls.length, 0);

  await service.signInWithDiscord({
    code: 'auth-code',
    codeVerifier: 'Az09-._~'.repeat(16),
    redirectUri: ALLOWED_REDIRECT,
  });
  assert.deepEqual(discordCalls, [
    { code: 'auth-code', codeVerifier: 'Az09-._~'.repeat(16), redirectUri: ALLOWED_REDIRECT },
  ]);
});

test('verifyDiscordCode sends code_verifier in the token exchange', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-id';
  process.env.DISCORD_CLIENT_SECRET = 'client-secret';
  const posts = [];
  const http = {
    post: async (url, body) => {
      posts.push({ url, body: Object.fromEntries(body) });
      return { data: { access_token: 'access' } };
    },
    get: async (url, { headers }) => {
      assert.equal(headers.authorization, 'Bearer access');
      return { data: { id: 'd-1', email: 'fan@example.com', verified: true } };
    },
  };

  const discordUser = await verifyDiscordCode(
    { code: 'auth-code', codeVerifier: VERIFIER, redirectUri: ALLOWED_REDIRECT },
    { http },
  );
  assert.deepEqual(discordUser, { id: 'd-1', email: 'fan@example.com', verified: true });
  assert.equal(posts[0].url, '/oauth2/token');
  assert.equal(posts[0].body.code_verifier, VERIFIER);
  assert.equal(posts[0].body.grant_type, 'authorization_code');
  assert.equal(posts[0].body.redirect_uri, ALLOWED_REDIRECT);
});

test('sign-in failures return fixed 401 messages that never echo the provider error', async () => {
  const leaky = new Error('token for leaked@example.com rejected');
  leaky.response = { status: 400, data: { email: 'leaked@example.com' } };
  const { service, db } = buildAuthService({ googlePayload: leaky, discordUser: leaky });
  const app = makeTestApp('/api/auth', createAuthRouter({ authService: service }));
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const googleResponse = await jsonRequest(app, '/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential: 'bad' }),
    });
    const discordResponse = await jsonRequest(app, '/api/auth/discord', {
      method: 'POST',
      body: JSON.stringify({ code: 'bad', codeVerifier: VERIFIER, redirectUri: ALLOWED_REDIRECT }),
    });

    assert.equal(googleResponse.status, 401);
    assert.deepEqual(googleResponse.body, { error: 'Invalid Google credential.' });
    assert.equal(discordResponse.status, 401);
    assert.deepEqual(discordResponse.body, { error: 'Invalid Discord authorization.' });
    assert.deepEqual(logged, ['Discord sign-in failed: 400']);
    assert.equal(db.statements.length, 0);
  } finally {
    console.error = originalError;
  }
});

test('POST /api/auth/discord passes code, codeVerifier and redirectUri to the service', async () => {
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
    body: JSON.stringify({ code: 'auth-code', codeVerifier: VERIFIER, redirectUri: ALLOWED_REDIRECT }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { token: 'session-token', email: null });
  assert.deepEqual(calledWith, {
    code: 'auth-code',
    codeVerifier: VERIFIER,
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
