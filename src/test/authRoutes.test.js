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
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
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
