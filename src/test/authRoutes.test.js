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

test('requireAuth rejects requests with no Authorization header', async () => {
  const app = buildProtectedApp();
  const response = await request(app, '/protected');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'Unauthorized' });
});

test('requireAuth rejects an invalid (malformed) JWT', async () => {
  const app = buildProtectedApp();
  const response = await request(app, '/protected', {
    headers: { authorization: 'Bearer not-a-real-jwt' },
  });

  assert.equal(response.status, 401);
});

test('requireAuth rejects an expired JWT', async () => {
  const app = buildProtectedApp();
  const response = await request(app, '/protected', {
    headers: { authorization: `Bearer ${expiredToken()}` },
  });

  assert.equal(response.status, 401);
});

test('requireAuth accepts a valid JWT and attaches req.userId', async () => {
  const app = buildProtectedApp();
  const response = await request(app, '/protected', {
    headers: { authorization: `Bearer ${validToken('user-42')}` },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.userId, 'user-42');
});

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

test('unauthenticated GET /streak is rejected with 401', async () => {
  const router = createBoardGameRouter({
    boardGameStreakService: {
      getStreakForUser: async () => {
        throw new Error('should not be called without auth');
      },
    },
  });
  const app = makeTestApp('/api/board-game', router);
  const response = await request(app, '/api/board-game/streak');

  assert.equal(response.status, 401);
});

test('unauthenticated PUT /streak is rejected with 401', async () => {
  const router = createBoardGameRouter({
    boardGameStreakService: {
      putStreakForUser: async () => {
        throw new Error('should not be called without auth');
      },
    },
  });
  const app = makeTestApp('/api/board-game', router);
  const response = await request(app, '/api/board-game/streak', {
    method: 'PUT',
    body: JSON.stringify({ wins: {}, lastWinDate: null }),
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(response.status, 401);
});

test('authenticated GET /streak reaches the service with req.userId', async () => {
  let calledWith = null;
  const router = createBoardGameRouter({
    boardGameStreakService: {
      getStreakForUser: async (userId) => {
        calledWith = userId;
        return { wins: { '2026-01-01': true }, lastWinDate: '2026-01-01' };
      },
    },
  });
  const app = makeTestApp('/api/board-game', router);
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
