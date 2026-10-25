const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');
const jwt = require('jsonwebtoken');

const { makeTestApp, jsonRequest: request } = require('./testApp.js');

const sessionJwt = require('#platform/sessionJwt.js');
const {
  createAfterActionReportService,
} = require('#slices/afterActionReports/afterActionReportService.js');
const {
  createPushNotificationService,
  buildNotification,
} = require('#slices/pushNotifications/pushNotificationService.js');
const {
  createAfterActionReportsRouter,
  createFavoritesRouter,
} = require('#presentation/routes/afterActionReports.js');
const { createPushRouter } = require('#presentation/routes/push.js');
const { hasActiveGames } = require('#slices/pushNotifications/activeGames.js');

const SECRET = 'test-session-secret';
const CRON = 'cron-secret-value';
const ENDPOINT = 'https://push.example.com/send/abc';
const NOTIFIER_SECRET = 'notifier-callback-secret';
const NOW = Date.parse('2026-10-19T04:00:00Z');

beforeEach(() => {
  process.env.SESSION_JWT_SECRET = SECRET;
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  process.env.CRON_SECRET = CRON;
  process.env.NOTIFIER_CALLBACK_SECRET = NOTIFIER_SECRET;
});

function authHeaders(userId = 7) {
  return { authorization: `Bearer ${sessionJwt.signSessionToken({ userId })}` };
}

function game(overrides) {
  return {
    gameId: 1,
    date: '2026-10-18',
    gameTime: '2026-10-19T00:00:00Z',
    homeTeam: 'TOR',
    homeLogo: 'tor.svg',
    homeScore: 4,
    awayTeam: 'MTL',
    awayLogo: 'mtl.svg',
    awayScore: 2,
    periodType: 'REG',
    isPlayoff: false,
    gameState: 'OFF',
    ...overrides,
  };
}

/** In-memory Postgres stand-in covering every statement the slices issue. */
function fakeDb() {
  const db = {
    favorites: [], // { user_id, team_tri_code, created_at, push_muted }
    reads: new Set(),
    subs: [], // { id, user_id, endpoint, p256dh, auth }
    ledger: new Set(),
    pushOff: new Set(), // user ids (strings) with the account switch off
    nextId: 1,
  };
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT team_tri_code')) {
        return {
          rows: db.favorites
            .filter((favorite) => favorite.user_id === params[0])
            .map((favorite) => ({ ...favorite })),
        };
      }
      if (sql.includes("hashtext('favorite_teams')")) return { rows: [] };
      if (sql.includes('AS favorite_count')) {
        const userFavorites = db.favorites.filter((favorite) => favorite.user_id === params[0]);
        return {
          rows: [
            {
              is_already_favorite: userFavorites.some(
                (favorite) => favorite.team_tri_code === params[1],
              ),
              favorite_count: userFavorites.length,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO favorite_teams')) {
        if (
          !db.favorites.some(
            (favorite) => favorite.user_id === params[0] && favorite.team_tri_code === params[1],
          )
        ) {
          db.favorites.push({
            user_id: params[0],
            team_tri_code: params[1],
            created_at: '2026-10-01T00:00:00.000Z',
            push_muted: false,
          });
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE favorite_teams')) {
        const row = db.favorites.find(
          (favorite) => favorite.user_id === params[0] && favorite.team_tri_code === params[1],
        );
        if (row) row.push_muted = params[2];
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('FROM after_action_report_reads')) {
        return {
          rows: params[1]
            .filter((id) => db.reads.has(`${params[0]}:${id}`))
            .map((game_id) => ({ game_id: String(game_id) })),
        };
      }
      if (sql.includes('INSERT INTO after_action_report_reads')) {
        for (const id of params[1]) db.reads.add(`${params[0]}:${id}`);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO push_subscriptions')) {
        const [user_id, endpoint, p256dh, auth] = params;
        const existing = db.subs.find(
          (subscription) => subscription.endpoint === endpoint,
        );
        const previous_user_id = existing ? existing.user_id : null;
        if (existing) Object.assign(existing, { user_id, p256dh, auth });
        else db.subs.push({ id: db.nextId++, user_id, endpoint, p256dh, auth });
        return { rows: [{ previous_user_id }] };
      }
      if (sql.includes('DELETE FROM push_subscriptions WHERE user_id')) {
        const before = db.subs.length;
        db.subs = db.subs.filter(
          (subscription) =>
            !(
              subscription.user_id === params[0] &&
              subscription.endpoint === params[1]
            ),
        );
        return { rows: [], rowCount: before - db.subs.length };
      }
      if (sql.includes('DELETE FROM push_subscriptions WHERE endpoint')) {
        db.subs = db.subs.filter(
          (subscription) => subscription.endpoint !== params[0],
        );
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM after_action_report_pushes')) {
        db.ledger.delete(`${params[0]}:${params[1]}`);
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM push_subscriptions WHERE id')) {
        db.subs = db.subs.filter(
          (subscription) => subscription.id !== params[0],
        );
        return { rows: [] };
      }
      if (sql.includes('SELECT DISTINCT push_subscriptions.user_id')) {
        return {
          rows: [
            ...new Set(db.subs.map((subscription) => subscription.user_id)),
          ]
            .filter((user_id) => !db.pushOff.has(String(user_id)))
            .map((user_id) => ({ user_id })),
        };
      }
      if (sql.includes('SELECT push_enabled')) {
        return { rows: [{ push_enabled: !db.pushOff.has(String(params[0])) }] };
      }
      if (sql.includes('UPDATE users SET push_enabled')) {
        const [userId, enabled] = params;
        const wasEnabled = !db.pushOff.has(String(userId));
        if (enabled) db.pushOff.delete(String(userId));
        else db.pushOff.add(String(userId));
        return { rows: [], rowCount: wasEnabled === enabled ? 0 : 1 };
      }
      if (sql.includes('FROM push_subscriptions')) {
        return {
          rows: db.subs
            .filter((subscription) => subscription.user_id === params[0])
            .map((subscription) => ({ ...subscription })),
        };
      }
      if (
        sql.includes('SELECT game_id') &&
        sql.includes('after_action_report_pushes')
      ) {
        return {
          rows: params[1]
            .filter((id) => db.ledger.has(`${params[0]}:${id}`))
            .map((game_id) => ({ game_id: String(game_id) })),
        };
      }
      if (
        sql.includes('INSERT INTO after_action_report_pushes') &&
        sql.includes('UNNEST')
      ) {
        for (const id of params[1]) db.ledger.add(`${params[0]}:${id}`);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO after_action_report_pushes')) {
        const key = `${params[0]}:${params[1]}`;
        if (db.ledger.has(key)) return { rows: [] };
        db.ledger.add(key);
        return { rows: [{ game_id: params[1] }] };
      }
      if (sql.includes('INSERT INTO weekly_player_report_pushes')) {
        db.weeklySeeded = (db.weeklySeeded ?? 0) + 1;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  db.withTransaction = (fn) => fn(client);
  return db;
}

const LIVE_SCOREBOARD = [{ gameState: 'LIVE', startTimeUTC: '2026-10-19T03:00:00Z' }];

function build({
  games,
  sendImpl,
  favoritePlayers = [],
  boxscore,
  boxscoreError,
  scoreboardGames = LIVE_SCOREBOARD,
  notifier,
} = {}) {
  const db = fakeDb();
  const scheduleCalls = { season: [], recent: [] };
  const gameList = games ?? [game({ gameId: 100 })];
  const scheduleService = {
    getGameBoxscore: async () => {
      scheduleCalls.boxscores = (scheduleCalls.boxscores ?? 0) + 1;
      if (boxscoreError) throw boxscoreError;
      return boxscore;
    },
    getTeamSchedule: async (triCode) => {
      scheduleCalls.season.push(triCode);
      return { games: [] };
    },
    getRecentTeamGames: async (triCode, options) => {
      scheduleCalls.recent.push([triCode, Boolean(options?.fresh)]);
      return {
        games: gameList.filter(
          (game) => game.homeTeam === triCode || game.awayTeam === triCode,
        ),
      };
    },
  };
  const afterActionReportService = createAfterActionReportService({
    withTransaction: db.withTransaction,
    seasons: { getCurrentSeasonId: () => '20262027' },
    scheduleService,
  });
  const sent = [];
  const webPush = {
    sendNotification: async (subscription, payload, options) => {
      if (sendImpl) await sendImpl(subscription);
      sent.push({ subscription, payload: JSON.parse(payload), options });
    },
  };
  const pushNotificationService = createPushNotificationService({
    withTransaction: db.withTransaction,
    sessionJwt,
    afterActionReportService,
    weeklyPlayerReportService: { listFavorites: async () => favoritePlayers },
    scheduleService,
    webPush,
    ...(notifier ? { notifier } : {}),
    listScoreboardGames: async () => scoreboardGames,
    now: () => NOW,
  });
  const pass = (req, res, next) => next();
  return {
    db,
    sent,
    scheduleCalls,
    afterActionReportService,
    pushNotificationService,
    push: makeTestApp(
      '/api/push',
      createPushRouter({ pushNotificationService, dispatchRateLimiter: pass }),
    ),
    favorites: makeTestApp(
      '/api/favorites',
      createFavoritesRouter({ afterActionReportService }),
    ),
    reports: makeTestApp(
      '/api/after-action-reports',
      createAfterActionReportsRouter({ afterActionReportService }),
    ),
  };
}

const json = (body) => JSON.stringify(body);
const subscribeBody = (endpoint = ENDPOINT) =>
  json({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
const cronHeaders = (secret = CRON) => ({ authorization: `Bearer ${secret}` });

test('game notification highlights only favorite skaters and their scoring milestones', () => {
  const favorites = [
    { playerId: 1, name: 'Goal Scorer' },
    { playerId: 2, name: 'Play Maker' },
    { playerId: 3, name: 'Multi Point' },
    { playerId: 4, name: 'Hat Trick' },
    { playerId: 5, name: 'No Points' },
  ];
  const boxscore = { playerByGameStats: {
    homeTeam: { forwards: [
      { playerId: 1, goals: 1, assists: 0 },
      { playerId: 2, goals: 0, assists: 1 },
      { playerId: 4, goals: 3, assists: 1 },
      { playerId: 5, goals: 0, assists: 0 },
      { playerId: 99, goals: 2, assists: 0 },
    ] },
    awayTeam: { defense: [{ playerId: 3, goals: 1, assists: 1 }] },
  } };
  const notification = buildNotification(game({ periodType: 'OT' }), favorites, boxscore);
  assert.equal(notification.body, 'Goal Scorer: 1 goal · Play Maker: 1 assist · Multi Point: 1 goal, 1 assist — 2-point game! · Hat Trick: 3 goals, 1 assist — hat trick! · MTL 2 @ TOR 4 (OT)');
  assert.equal(buildNotification(game(), favorites).body, 'MTL 2 @ TOR 4');
  assert.equal(buildNotification(game(), [], boxscore).body, 'MTL 2 @ TOR 4');
});

test('dispatch personalizes game notifications and shares the boxscore across users', async () => {
  const ctx = build({
    favoritePlayers: [{ playerId: 1, name: 'Favorite Player' }],
    boxscore: { playerByGameStats: { homeTeam: { forwards: [
      { playerId: 1, goals: 0, assists: 2 },
    ] } } },
  });
  await setupUser(ctx, 7, ['TOR']);
  await setupUser(ctx, 8, ['TOR'], ['https://push.example.com/send/u8']);
  assert.equal((await dispatch(ctx)).sent, 2);
  assert.equal(ctx.sent[0].payload.body, 'Favorite Player: 2 assists — 2-point game! · MTL 2 @ TOR 4');
  assert.equal(ctx.scheduleCalls.boxscores, 1);
});

test('dispatch still sends the score when the boxscore is unavailable', async () => {
  const ctx = build({
    favoritePlayers: [{ playerId: 1, name: 'Favorite Player' }],
    boxscoreError: new Error('NHL unavailable'),
  });
  await setupUser(ctx, 7, ['TOR']);
  assert.equal((await dispatch(ctx)).sent, 1);
  assert.equal(ctx.sent[0].payload.body, 'MTL 2 @ TOR 4');
});

async function dispatch(ctx) {
  const response = await request(ctx.push, '/api/push/dispatch', {
    method: 'POST',
    headers: cronHeaders(),
  });
  assert.equal(response.status, 200);
  return response.body;
}

test('config reflects VAPID env; subscribe validates input, session, and config', async () => {
  const ctx = build();
  const { push } = ctx;
  assert.deepEqual((await request(push, '/api/push/config')).body, {
    enabled: true,
    publicKey: 'pub',
  });
  delete process.env.VAPID_SUBJECT;
  assert.deepEqual((await request(push, '/api/push/config')).body, {
    enabled: false,
    publicKey: null,
  });
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';

  const post = (body, headers = authHeaders()) =>
    request(ctx.push, '/api/push/subscriptions', {
      method: 'POST',
      body,
      headers,
    });

  assert.equal((await post(subscribeBody(), {})).status, 401);
  assert.equal((await post(json({}))).status, 400);
  assert.equal(
    (await post(subscribeBody('http://insecure.example.com/x'))).status,
    400,
  );
  assert.equal((await post(subscribeBody('not a url'))).status, 400);
  assert.equal(
    (await post(json({ endpoint: ENDPOINT, keys: { p256dh: 'p' } }))).status,
    400,
  );
  assert.equal(ctx.db.subs.length, 0);

  delete process.env.VAPID_PRIVATE_KEY;
  assert.equal((await post(subscribeBody())).status, 503);
});

test('subscribe upserts by endpoint, seeds the ledger; unsubscribe removes only own rows', async () => {
  const ctx = build({ games: [game({ gameId: 100 }), game({ gameId: 101 })] });
  await ctx.afterActionReportService.addFavorite(7, 'TOR');
  await ctx.afterActionReportService.addFavorite(8, 'TOR');

  const post = (userId, body = subscribeBody()) =>
    request(ctx.push, '/api/push/subscriptions', {
      method: 'POST',
      body,
      headers: authHeaders(userId),
    });
  assert.equal((await post(7)).status, 204);
  assert.deepEqual([...ctx.db.ledger].sort(), ['7:100', '7:101']);

  // Same endpoint from another account moves the row instead of duplicating.
  assert.equal((await post(8)).status, 204);
  assert.equal(ctx.db.subs.length, 1);
  assert.equal(ctx.db.subs[0].user_id, 8);

  // Seeded reports are never pushed.
  const dispatchSummary = await dispatch(ctx);
  assert.deepEqual(dispatchSummary, { users: 1, sent: 0, removed: 0 });
  assert.equal(ctx.sent.length, 0);

  // Unsubscribe only deletes the caller's own row (user 8 owns it now).
  const del = (userId, endpoint) =>
    request(ctx.push, '/api/push/subscriptions', {
      method: 'DELETE',
      body: json({ endpoint }),
      headers: authHeaders(userId),
    });

  assert.equal((await del(7, ENDPOINT)).status, 204);
  assert.equal(ctx.db.subs.length, 1);
  assert.equal((await del(8, ENDPOINT)).status, 204);
  assert.equal(ctx.db.subs.length, 0);
  assert.equal((await del(8, ENDPOINT)).status, 204); // already gone
});

test('push-mute route updates the favorite and favorites expose pushMuted', async () => {
  const ctx = build();
  await ctx.afterActionReportService.addFavorite(7, 'TOR');
  const put = (path, body, headers = authHeaders()) =>
    request(ctx.favorites, path, { method: 'PUT', body, headers });

  assert.equal(
    (await put('/api/favorites/TOR/push-mute', json({ muted: true }), {}))
      .status,
    401,
  );
  assert.equal(
    (await put('/api/favorites/TOR/push-mute', json({ muted: 'yes' }))).status,
    400,
  );
  assert.equal(
    (await put('/api/favorites/TOR/push-mute', json({}))).status,
    400,
  );
  assert.equal(
    (await put('/api/favorites/BOS/push-mute', json({ muted: true }))).status,
    404,
  );

  const muted = await put(
    '/api/favorites/tor/push-mute',
    json({ muted: true }),
  );
  assert.equal(muted.status, 200);
  assert.equal(muted.body.favorites[0].pushMuted, true);

  const favoritesResponse = await request(ctx.favorites, '/api/favorites', {
    headers: authHeaders(),
  });
  assert.equal(favoritesResponse.body.favorites[0].pushMuted, true);
  const added = await put('/api/favorites/MTL', json({}));
  assert.equal(
    added.body.favorites.find((favorite) => favorite.triCode === 'MTL').pushMuted,
    false,
  );
});

test("read route marks the token's game read; read and session tokens are not interchangeable", async () => {
  const ctx = build();
  const post = (token) =>
    request(ctx.push, '/api/push/read', {
      method: 'POST',
      body: json({ token }),
    });

  const valid = sessionJwt.signReadToken({ userId: 7, gameId: 100 });
  assert.equal((await post(valid)).status, 204);
  assert.ok(ctx.db.reads.has('7:100'));

  ctx.db.reads.clear();
  assert.equal(
    (await post(sessionJwt.signSessionToken({ userId: 7 }))).status,
    401,
  );
  assert.equal((await post('garbage')).status, 401);
  assert.equal((await post(undefined)).status, 401);
  const expired = jwt.sign(
    { purpose: 'aar-read', sub: '7', gameId: 100 },
    SECRET,
    { expiresIn: -10 },
  );
  assert.equal((await post(expired)).status, 401);
  const wrongSecret = jwt.sign(
    { purpose: 'aar-read', sub: '7', gameId: 100 },
    'other',
  );
  assert.equal((await post(wrongSecret)).status, 401);
  assert.equal(ctx.db.reads.size, 0);

  // Read and session tokens are not interchangeable.
  const readToken = sessionJwt.signReadToken({ userId: 7, gameId: 100 });
  const decoded = jwt.decode(readToken);
  assert.equal(decoded.purpose, 'aar-read');
  assert.equal(decoded.sub, '7');
  assert.equal(decoded.gameId, 100);
  assert.ok(decoded.exp - decoded.iat === 30 * 24 * 60 * 60);

  assert.throws(() => sessionJwt.verifySessionToken(readToken));
  assert.throws(() =>
    sessionJwt.verifyReadToken(sessionJwt.signSessionToken({ userId: 7 })),
  );
  assert.deepEqual(sessionJwt.verifyReadToken(readToken), {
    userId: '7',
    gameId: 100,
  });

  // requireAuth rejects a read token presented as a session.
  const response = await request(ctx.reports, '/api/after-action-reports', {
    headers: { authorization: `Bearer ${readToken}` },
  });
  assert.equal(response.status, 401);
});

test('dispatch requires the cron secret and configuration', async () => {
  const ctx = build();
  const post = (headers) =>
    request(ctx.push, '/api/push/dispatch', { method: 'POST', headers });

  assert.equal((await post({})).status, 401);
  assert.equal((await post(cronHeaders('wrong'))).status, 401);
  assert.equal((await post(cronHeaders(`${CRON}x`))).status, 401);
  assert.equal((await post({ authorization: CRON })).status, 401);
  assert.equal((await post(cronHeaders())).status, 200);

  delete process.env.CRON_SECRET;
  assert.equal((await post(cronHeaders())).status, 503);
  process.env.CRON_SECRET = CRON;
  delete process.env.VAPID_PUBLIC_KEY;
  assert.equal((await post(cronHeaders())).status, 503);
});

async function setupUser(ctx, userId, teams, endpoints = [ENDPOINT]) {
  for (const team of teams)
    await ctx.afterActionReportService.addFavorite(userId, team);
  for (const endpoint of endpoints) {
    ctx.db.subs.push({
      id: ctx.db.nextId++,
      user_id: userId,
      endpoint,
      p256dh: 'p',
      auth: 'a',
    });
  }
}

test('dispatch skips read, ledgered, old and all-muted games, but not partly muted ones', async () => {
  const ctx = build({
    games: [
      game({ gameId: 1, homeTeam: 'TOR', awayTeam: 'MTL' }), // read
      game({ gameId: 2, homeTeam: 'TOR', awayTeam: 'MTL' }), // ledgered
      game({
        gameId: 3,
        homeTeam: 'TOR',
        awayTeam: 'MTL',
        gameTime: '2026-10-18T15:00:00Z',
      }), // >12h old
      game({ gameId: 4, homeTeam: 'BOS', awayTeam: 'NYR' }), // muted team
      game({ gameId: 5, homeTeam: 'TOR', awayTeam: 'MTL' }), // sendable
    ],
  });
  await setupUser(ctx, 7, ['TOR', 'BOS']);
  ctx.db.favorites.find((favorite) => favorite.team_tri_code === 'BOS').push_muted = true;
  ctx.db.reads.add('7:1');
  ctx.db.ledger.add('7:2');

  const dispatchSummary = await dispatch(ctx);
  assert.deepEqual(dispatchSummary, { users: 1, sent: 1, removed: 0 });
  assert.deepEqual(
    ctx.sent.map((sentPush) => sentPush.payload.gameId),
    [5],
  );
  assert.ok(ctx.db.ledger.has('7:5'));
  assert.ok(ctx.db.ledger.has('7:4'));

  // Unmuting later must not push the game that finished while muted.
  ctx.db.favorites.find((favorite) => favorite.team_tri_code === 'BOS').push_muted = false;
  assert.deepEqual(await dispatch(ctx), { users: 1, sent: 0, removed: 0 });

  // A game pushes when at least one of its favorites is unmuted.
  const partial = build({
    games: [game({ gameId: 9, homeTeam: 'TOR', awayTeam: 'MTL' })],
  });
  await setupUser(partial, 7, ['TOR', 'MTL']);
  partial.db.favorites.find((favorite) => favorite.team_tri_code === 'TOR').push_muted = true;

  assert.equal((await dispatch(partial)).sent, 1);
  assert.equal(partial.sent.length, 1);
});

test('dispatch sends one push per game to every device with the contract payload', async () => {
  const ctx = build({
    games: [
      game({ gameId: 9, homeTeam: 'TOR', awayTeam: 'MTL', periodType: 'OT' }),
    ],
  });
  await setupUser(
    ctx,
    7,
    ['TOR', 'MTL'],
    [ENDPOINT, 'https://push.example.com/send/two'],
  );

  const dispatchSummary = await dispatch(ctx);
  assert.deepEqual(dispatchSummary, { users: 1, sent: 2, removed: 0 });
  assert.deepEqual(
    ctx.sent.map((sentPush) => sentPush.subscription.endpoint).sort(),
    [ENDPOINT, 'https://push.example.com/send/two'],
  );
  const { payload, options } = ctx.sent[0];
  assert.equal(payload.title, 'After Action Report');
  assert.equal(payload.body, 'MTL 2 @ TOR 4 (OT)');
  assert.equal(payload.gameId, 9);
  assert.equal(payload.tag, 'aar-9');
  assert.deepEqual(sessionJwt.verifyReadToken(payload.readToken), {
    userId: '7',
    gameId: 9,
  });
  assert.equal(options.TTL, 6 * 60 * 60);
  assert.equal(options.urgency, 'normal');

  // A second dispatch sends nothing.
  assert.deepEqual(await dispatch(ctx), { users: 1, sent: 0, removed: 0 });
  assert.equal(ctx.sent.length, 2);
});

test('dispatch removes subscriptions the push service reports gone', async () => {
  const gone = 'https://push.example.com/send/gone';
  const ctx = build({
    games: [game({ gameId: 9 })],
    sendImpl: async (subscription) => {
      if (subscription.endpoint === gone)
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (subscription.endpoint.endsWith('/boom'))
        throw Object.assign(new Error('boom'), { statusCode: 500 });
    },
  });
  await setupUser(
    ctx,
    7,
    ['TOR'],
    [gone, 'https://push.example.com/send/boom', ENDPOINT],
  );

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  let dispatchSummary;
  try {
    dispatchSummary = await dispatch(ctx);
  } finally {
    console.error = original;
  }
  assert.deepEqual(dispatchSummary, { users: 1, sent: 1, removed: 1 });
  assert.equal(ctx.db.subs.length, 2);
  assert.ok(!ctx.db.subs.some((subscription) => subscription.endpoint === gone));
  assert.equal(errors.length, 1);
});

test('dispatch loads each distinct team schedule once, fresh', async () => {
  const ctx = build({
    games: [game({ gameId: 9, homeTeam: 'TOR', awayTeam: 'MTL' })],
  });
  await setupUser(ctx, 7, ['TOR', 'MTL'], [ENDPOINT]);
  await setupUser(ctx, 8, ['TOR'], ['https://push.example.com/send/u8']);
  await setupUser(ctx, 9, ['MTL'], ['https://push.example.com/send/u9']);

  const dispatchSummary = await dispatch(ctx);
  assert.deepEqual(dispatchSummary, { users: 3, sent: 3, removed: 0 });
  assert.deepEqual(ctx.scheduleCalls.season.sort(), ['MTL', 'TOR']);
  assert.deepEqual(ctx.scheduleCalls.recent.sort(), [
    ['MTL', true],
    ['TOR', true],
  ]);
});

test('hasActiveGames covers live, recent final, old final and upcoming games', () => {
  const now = Date.parse('2026-10-19T04:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();

  assert.equal(hasActiveGames([], now), false);
  assert.equal(hasActiveGames(undefined, now), false);
  assert.equal(
    hasActiveGames([{ gameState: 'LIVE', startTimeUTC: hoursAgo(1) }], now),
    true,
  );
  assert.equal(
    hasActiveGames([{ gameState: 'CRIT', startTimeUTC: hoursAgo(2) }], now),
    true,
  );
  assert.equal(
    hasActiveGames([{ gameState: 'FINAL', startTimeUTC: hoursAgo(3) }], now),
    true,
  );
  assert.equal(
    hasActiveGames([{ gameState: 'OFF', startTimeUTC: hoursAgo(4.4) }], now),
    true,
  );
  assert.equal(
    hasActiveGames([{ gameState: 'OFF', startTimeUTC: hoursAgo(4.6) }], now),
    false,
  );
  assert.equal(
    hasActiveGames([{ gameState: 'FUT', startTimeUTC: hoursAgo(-2) }], now),
    false,
  );
  assert.equal(
    hasActiveGames([{ gameState: 'PRE', startTimeUTC: hoursAgo(0) }], now),
    false,
  );
  assert.equal(hasActiveGames([{ gameState: 'FINAL' }], now), false);
});

test('dispatch skips when no game is live or recently final, but not when the scoreboard is down', async () => {
  const quiet = build({
    scoreboardGames: [{ gameState: 'FUT', startTimeUTC: '2026-10-19T23:00:00Z' }],
  });
  await setupUser(quiet, 7, ['TOR']);
  assert.deepEqual(await dispatch(quiet), {
    skipped: 'no-active-games',
    users: 0,
    sent: 0,
    removed: 0,
  });
  assert.equal(quiet.scheduleCalls.recent.length, 0);

  const scoreboardDown = build({ scoreboardGames: null });
  await setupUser(scoreboardDown, 7, ['TOR']);
  assert.equal((await dispatch(scoreboardDown)).sent, 1);
});

/** Runs `work` with console.error silenced. */
async function withoutErrorLogs(work) {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
}

test('a game no device received is released, so the next dispatch retries it', async () => {
  let isPushServiceDown = true;
  const ctx = build({
    games: [game({ gameId: 9 })],
    sendImpl: async () => {
      if (isPushServiceDown)
        throw Object.assign(new Error('unavailable'), { statusCode: 503 });
    },
  });
  await setupUser(ctx, 7, ['TOR']);

  assert.equal((await withoutErrorLogs(() => dispatch(ctx))).sent, 0);
  assert.ok(!ctx.db.ledger.has('7:9'));

  isPushServiceDown = false;
  assert.equal((await dispatch(ctx)).sent, 1);
  assert.ok(ctx.db.ledger.has('7:9'));
  assert.equal((await dispatch(ctx)).sent, 0);
});

test('with the notifier configured, pushes are queued there with per-device dedupe keys', async () => {
  const notifierConfig = { url: 'http://127.0.0.1:9100', token: 'notifier-token' };
  const enqueued = [];
  let isNotifierDown = true;
  const notifier = {
    readNotifierConfig: () => notifierConfig,
    enqueueMessages: async (config, messages) => {
      assert.equal(config, notifierConfig);
      if (isNotifierDown) throw new Error('ECONNREFUSED');
      enqueued.push(...messages);
    },
  };
  const ctx = build({ games: [game({ gameId: 9 })], notifier });
  await setupUser(ctx, 7, ['TOR'], [ENDPOINT, 'https://push.example.com/send/two']);

  // A notifier outage releases the claim instead of losing the push.
  assert.equal((await withoutErrorLogs(() => dispatch(ctx))).sent, 0);
  assert.ok(!ctx.db.ledger.has('7:9'));

  isNotifierDown = false;
  assert.deepEqual(await dispatch(ctx), { users: 1, sent: 2, removed: 0 });
  assert.equal(ctx.sent.length, 0);
  assert.deepEqual(
    enqueued.map((message) => message.dedupeKey),
    ['aar-9:u7:s1', 'aar-9:u7:s2'],
  );
  const [first] = enqueued;
  assert.deepEqual(first.subscription, {
    endpoint: ENDPOINT,
    keys: { p256dh: 'p', auth: 'a' },
  });
  assert.equal(first.payload.tag, 'aar-9');
  assert.equal(first.ttlSeconds, 6 * 60 * 60);
  assert.equal(first.urgency, 'normal');
});

test('notifier events need the callback secret; a gone subscription is deleted', async () => {
  const ctx = build();
  await setupUser(ctx, 7, ['TOR'], [ENDPOINT, 'https://push.example.com/send/keep']);
  const post = (body, secret = NOTIFIER_SECRET) =>
    request(ctx.push, '/api/push/notifier-events', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: json(body),
    });

  assert.equal((await post({ type: 'subscription.gone', endpoint: ENDPOINT }, 'wrong')).status, 401);
  assert.equal(ctx.db.subs.length, 2);

  assert.equal((await post({ type: 'subscription.gone', endpoint: ENDPOINT })).status, 204);
  assert.deepEqual(
    ctx.db.subs.map((subscription) => subscription.endpoint),
    ['https://push.example.com/send/keep'],
  );
  assert.equal((await post({ type: 'something.new' })).status, 204);
  assert.equal((await post({ type: 'subscription.gone' })).status, 400);

  delete process.env.NOTIFIER_CALLBACK_SECRET;
  assert.equal((await post({ type: 'subscription.gone', endpoint: ENDPOINT })).status, 503);
});

test('re-syncing a device the account already has does not reseed the ledger; a new device does', async () => {
  const ctx = build({ games: [game({ gameId: 100 })] });
  const post = (endpoint) =>
    request(ctx.push, '/api/push/subscriptions', {
      method: 'POST',
      body: subscribeBody(endpoint),
      headers: authHeaders(7),
    });
  assert.equal((await post(ENDPOINT)).status, 204);
  await ctx.afterActionReportService.addFavorite(7, 'TOR');

  // The app re-sends this device on load while game 100 waits to be pushed.
  assert.equal((await post(ENDPOINT)).status, 204);
  assert.equal(ctx.db.ledger.size, 0);
  assert.deepEqual(await dispatch(ctx), { users: 1, sent: 1, removed: 0 });

  // A second device is new to the account, so it seeds what is already there.
  ctx.db.ledger.clear();
  assert.equal((await post('https://push.example.com/send/two')).status, 204);
  assert.deepEqual([...ctx.db.ledger], ['7:100']);
});

test('account switch: get, set, validate; off skips dispatch; back on does not push what finished while off', async () => {
  const ctx = build({ games: [game({ gameId: 100 })] });
  await setupUser(ctx, 7, ['TOR']);
  const get = (headers = authHeaders(7)) =>
    request(ctx.push, '/api/push/notifications', { headers });
  const put = (body) =>
    request(ctx.push, '/api/push/notifications', {
      method: 'PUT',
      body,
      headers: authHeaders(7),
    });

  assert.equal((await get({})).status, 401);
  assert.deepEqual((await get()).body, { enabled: true });
  assert.equal((await put(json({ enabled: 'no' }))).status, 400);

  assert.deepEqual((await put(json({ enabled: false }))).body, { enabled: false });
  assert.deepEqual((await get()).body, { enabled: false });
  assert.deepEqual(await dispatch(ctx), { users: 0, sent: 0, removed: 0 });

  assert.deepEqual((await put(json({ enabled: true }))).body, { enabled: true });
  assert.ok(ctx.db.ledger.has('7:100'));
  assert.deepEqual(await dispatch(ctx), { users: 1, sent: 0, removed: 0 });

  // Saying "on" again when it is already on does not reseed.
  ctx.db.ledger.clear();
  await put(json({ enabled: true }));
  assert.equal(ctx.db.ledger.size, 0);
});
