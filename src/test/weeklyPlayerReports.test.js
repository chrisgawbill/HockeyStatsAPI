const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

const { makeTestApp, jsonRequest: request } = require('./testApp.js');
const sessionJwt = require('#platform/sessionJwt.js');
const {
  previousWeekStart,
  formatWeekLabel,
  isWeekStart,
  summarizeWeekSchedule,
  normalizeGameRows,
  buildWeeklyReport,
} = require('#slices/weeklyPlayerReports/weeklyReportBuilder.js');
const {
  createWeeklyPlayerReportService,
} = require('#slices/weeklyPlayerReports/weeklyPlayerReportService.js');
const {
  createPushNotificationService,
} = require('#slices/pushNotifications/pushNotificationService.js');
const { createPushRouter } = require('#presentation/routes/push.js');
const {
  createFavoritePlayersRouter,
  createWeeklyPlayerReportsRouter,
} = require('#presentation/routes/weeklyPlayerReports.js');
const { isSendWindow } = require('../../bin/weekly-report-cron.js');

const SECRET = 'test-session-secret';
const CRON = 'cron-secret-value';
// Monday 2026-10-19 09:30 EDT; the report week is Oct 12–18.
const NOW = Date.parse('2026-10-19T13:30:00Z');
const WEEK = '2026-10-12';

const MCDAVID = 8478402;
const SKINNER = 8479973;
const HUGHES = 8480800;
const MATTHEWS = 8479318;

const PROFILES = {
  [MCDAVID]: ['Connor', 'McDavid', 'EDM', 'C'],
  [SKINNER]: ['Stuart', 'Skinner', 'EDM', 'G'],
  [HUGHES]: ['Quinn', 'Hughes', 'VAN', 'D'],
  [MATTHEWS]: ['Auston', 'Matthews', 'TOR', 'C'],
};
for (let id = 1; id <= 11; id += 1) {
  PROFILES[9000000 + id] = ['Depth', `Player${id}`, 'SEA', 'C'];
}

beforeEach(() => {
  process.env.SESSION_JWT_SECRET = SECRET;
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  process.env.CRON_SECRET = CRON;
});

function scheduleGame(id, away, home, gameType = 2, gameState = 'OFF') {
  return {
    id,
    gameType,
    gameState,
    awayTeam: { abbrev: away },
    homeTeam: { abbrev: home },
  };
}

const NORMAL_WEEK = {
  gameWeek: [
    { date: '2026-10-12', games: [] },
    { date: '2026-10-13', games: [scheduleGame(3, 'TOR', 'MTL', 1)] },
    { date: '2026-10-14', games: [scheduleGame(1, 'CGY', 'EDM')] },
    { date: '2026-10-15', games: [] },
    { date: '2026-10-16', games: [scheduleGame(4, 'OTT', 'TOR')] },
    { date: '2026-10-17', games: [] },
    { date: '2026-10-18', games: [scheduleGame(2, 'EDM', 'BOS')] },
  ],
};

const BREAK_WEEK = {
  gameWeek: [
    { date: '2026-10-12', games: [scheduleGame(3, 'TOR', 'MTL', 1)] },
    { date: '2026-10-18', games: [] },
  ],
};

const SKATER_ROWS = [
  {
    playerId: MCDAVID,
    gameId: 1,
    gameDate: '2026-10-14',
    teamAbbrev: 'EDM',
    opponentTeamAbbrev: 'CGY',
    goals: 1,
    assists: 3,
    points: 4,
    plusMinus: 2,
    shots: 5,
    timeOnIcePerGame: 1300,
  },
  {
    playerId: MCDAVID,
    gameId: 2,
    gameDate: '2026-10-18',
    teamAbbrev: 'EDM',
    opponentTeamAbbrev: 'BOS',
    goals: 1,
    assists: 1,
    points: 2,
    plusMinus: -1,
    shots: 6,
    timeOnIcePerGame: 1304,
  },
];

const GOALIE_ROWS = [
  {
    playerId: SKINNER,
    gameId: 2,
    gameDate: '2026-10-18',
    teamAbbrev: 'EDM',
    opponentTeamAbbrev: 'BOS',
    wins: 1,
    losses: 0,
    otLosses: 0,
    saves: 30,
    shotsAgainst: 32,
    goalsAgainst: 2,
    shutouts: 0,
    timeOnIce: 3600,
  },
];

/** In-memory Postgres stand-in for the weekly report and push statements. */
function fakeDb() {
  const db = {
    favorites: [], // { user_id, player_id, full_name, ..., created_at }
    reports: new Map(), // `${user}:${week}` -> { payload, created_at, read_at }
    ledger: new Set(),
    pushOff: new Set(),
    subs: [], // { id, user_id, endpoint, p256dh, auth }
    nextId: 1,
    clock: 0,
  };
  const key = (userId, weekStart) => `${userId}:${weekStart}`;
  const reportRow = (userId, weekStart) => {
    const storedReport = db.reports.get(key(userId, weekStart));
    return (
      storedReport && { user_id: userId, week_start: weekStart, ...storedReport }
    );
  };
  const client = {
    async query(sql, params = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('INSERT INTO favorite_players')) {
        const [user_id, player_id, full_name, team, position, headshot, limit] =
          params;
        const mine = db.favorites.filter((favorite) => favorite.user_id === user_id);
        const existing = mine.find((favorite) => favorite.player_id === String(player_id));
        if (existing) {
          Object.assign(existing, { full_name, team_tri_code: team });
          return { rows: [], rowCount: 1 };
        }
        if (mine.length >= limit) return { rows: [], rowCount: 0 };
        db.clock += 1;
        db.favorites.push({
          user_id,
          player_id: String(player_id),
          full_name,
          team_tri_code: team,
          position,
          headshot,
          created_at: new Date(Date.UTC(2026, 9, 1, 0, db.clock)),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM favorite_players')) {
        db.favorites = db.favorites.filter(
          (favorite) =>
            !(favorite.user_id === params[0] && favorite.player_id === String(params[1])),
        );
        return { rows: [] };
      }
      if (sql.includes('FROM favorite_players') && sql.includes('WHERE')) {
        return {
          rows: db.favorites.filter((favorite) => favorite.user_id === params[0]),
        };
      }
      if (sql.includes('FROM favorite_players')) {
        return { rows: [...db.favorites] };
      }
      if (sql.includes('INSERT INTO weekly_player_reports')) {
        const [userId, weekStart, payload] = params;
        if (db.reports.has(key(userId, weekStart))) {
          return { rows: [], rowCount: 0 };
        }
        db.reports.set(key(userId, weekStart), {
          payload: JSON.parse(payload),
          created_at: new Date(NOW),
          read_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE weekly_player_reports')) {
        const r = db.reports.get(key(String(params[0]), params[1]));
        if (r) r.read_at ??= new Date(NOW);
        return { rows: [], rowCount: r ? 1 : 0 };
      }
      if (
        sql.includes('INSERT INTO weekly_player_report_pushes') &&
        sql.includes('FROM weekly_player_reports')
      ) {
        for (const k of db.reports.keys()) {
          if (k.startsWith(`${params[0]}:`)) db.ledger.add(k);
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO weekly_player_report_pushes')) {
        const k = key(params[0], params[1]);
        if (db.ledger.has(k)) return { rows: [] };
        db.ledger.add(k);
        return { rows: [{ user_id: params[0] }] };
      }
      if (sql.includes('FROM weekly_player_reports') && sql.includes('LIMIT')) {
        return {
          rows: [...db.reports.keys()]
            .filter((reportKey) => reportKey.startsWith(`${params[0]}:`))
            .map((reportKey) => reportRow(params[0], reportKey.split(':')[1]))
            .sort((reportA, reportB) =>
              reportB.week_start.localeCompare(reportA.week_start),
            )
            .slice(0, params[1]),
        };
      }
      if (sql.includes('FROM weekly_player_reports') && sql.includes('$2')) {
        const row = reportRow(params[0], params[1]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM weekly_player_reports')) {
        return {
          rows: [...db.reports.keys()]
            .filter((reportKey) => reportKey.endsWith(`:${params[0]}`))
            .map((reportKey) => reportRow(reportKey.split(':')[0], params[0])),
        };
      }
      if (sql.includes('SELECT weekly_report_push')) {
        return {
          rows: [{ weekly_report_push: !db.pushOff.has(String(params[0])) }],
        };
      }
      if (sql.includes('UPDATE users SET weekly_report_push')) {
        if (params[1]) db.pushOff.delete(String(params[0]));
        else db.pushOff.add(String(params[0]));
        return { rows: [] };
      }
      if (sql.includes('weekly_report_push = false')) {
        return { rows: [...db.pushOff].map((id) => ({ id })) };
      }
      if (sql.includes('SELECT DISTINCT user_id')) {
        return {
          rows: [
            ...new Set(db.subs.map((subscription) => subscription.user_id)),
          ].map((user_id) => ({
            user_id,
          })),
        };
      }
      if (sql.includes('DELETE FROM push_subscriptions WHERE id')) {
        db.subs = db.subs.filter(
          (subscription) => subscription.id !== params[0],
        );
        return { rows: [] };
      }
      if (sql.includes('FROM push_subscriptions')) {
        return {
          rows: db.subs.filter(
            (subscription) => String(subscription.user_id) === String(params[0]),
          ),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  db.withTransaction = (fn) => fn(client);
  db.subscribe = (userId, endpoint = `https://push.example.com/${userId}`) =>
    db.subs.push({
      id: db.nextId++,
      user_id: userId,
      endpoint,
      p256dh: 'p',
      auth: 'a',
    });
  return db;
}

function fakeCache() {
  const store = new Map();
  return {
    store,
    CACHE_TYPES: { PLAYER: 'player', SCHEDULE: 'schedule' },
    async getOrFetchCached(type, key, fetcher) {
      const k = `${type}:${key}`;
      if (store.has(k)) return store.get(k);
      const value = await fetcher();
      store.set(k, value);
      return value;
    },
  };
}

function statsClient(rows, calls, fail) {
  return {
    async get(url) {
      calls.push(url);
      if (fail.stats) throw new Error('stats down');
      return { data: { data: rows, total: rows.length } };
    },
  };
}

function build({ schedule = NORMAL_WEEK, sendImpl } = {}) {
  const db = fakeDb();
  const cache = fakeCache();
  const calls = { nhl: [], skaters: [], goalies: [] };
  const fail = { stats: false };
  const nhlApi = {
    axiosNhl: {
      async get(url) {
        calls.nhl.push(url);
        const landing = url.match(/^\/player\/(\d+)\/landing$/);
        if (landing) {
          const profile = PROFILES[landing[1]];
          if (!profile) {
            throw Object.assign(new Error('404'), {
              response: { status: 404 },
            });
          }
          const [first, last, team, position] = profile;
          return {
            data: {
              firstName: { default: first },
              lastName: { default: last },
              currentTeamAbbrev: team,
              position,
              headshot: `https://assets.example/${landing[1]}.png`,
            },
          };
        }
        if (url === `/schedule/${WEEK}`) return { data: schedule };
        if (url.startsWith('/schedule/')) return { data: { gameWeek: [] } };
        throw new Error(`Unexpected NHL URL ${url}`);
      },
    },
    axiosNhlStats: statsClient(
      [
        ...SKATER_ROWS,
        SKATER_ROWS[0], // duplicate from an overlapping page
        { ...SKATER_ROWS[0], playerId: 1, gameId: 9 }, // not favorited
        { ...SKATER_ROWS[0], gameId: 7, gameDate: '2026-10-19' }, // next week
      ],
      calls.skaters,
      fail,
    ),
    axiosNhlGoalie: statsClient(GOALIE_ROWS, calls.goalies, fail),
  };
  const weeklyPlayerReportService = createWeeklyPlayerReportService({
    withTransaction: db.withTransaction,
    nhlApi,
    cache,
  });
  const sent = [];
  const webPush = {
    sendNotification: async (subscription, payload) => {
      if (sendImpl) await sendImpl(subscription);
      sent.push({ subscription, payload: JSON.parse(payload) });
    },
  };
  const pushNotificationService = createPushNotificationService({
    withTransaction: db.withTransaction,
    sessionJwt,
    afterActionReportService: {
      markRead: async () => {
        throw new Error('not an AAR token');
      },
    },
    weeklyPlayerReportService,
    webPush,
    now: () => NOW,
  });
  const pass = (req, res, next) => next();
  return {
    db,
    cache,
    calls,
    fail,
    sent,
    push: makeTestApp(
      '/api/push',
      createPushRouter({ pushNotificationService, dispatchRateLimiter: pass }),
    ),
    favorites: makeTestApp(
      '/api/favorite-players',
      createFavoritePlayersRouter({ weeklyPlayerReportService }),
    ),
    reports: makeTestApp(
      '/api/weekly-player-reports',
      createWeeklyPlayerReportsRouter({ weeklyPlayerReportService }),
    ),
  };
}

const json = (body) => JSON.stringify(body);
const auth = (userId = 7) => ({
  authorization: `Bearer ${sessionJwt.signSessionToken({ userId })}`,
});
const cron = (secret = CRON) => ({ authorization: `Bearer ${secret}` });

async function favorite(ctx, userId, playerId) {
  return request(ctx.favorites, `/api/favorite-players/${playerId}`, {
    method: 'PUT',
    headers: auth(userId),
  });
}

async function weeklyDispatch(ctx, body) {
  return request(ctx.push, '/api/push/weekly-dispatch', {
    method: 'POST',
    headers: cron(),
    body: body ? json(body) : undefined,
  });
}

/** User 7: three players and a phone; user 8: a VAN-only favorite; user 9: push off. */
async function seedUsers(ctx) {
  for (const id of [MCDAVID, SKINNER, HUGHES, MATTHEWS]) {
    assert.equal((await favorite(ctx, 7, id)).status, 200);
  }
  await favorite(ctx, 8, HUGHES);
  await favorite(ctx, 9, MCDAVID);
  ctx.db.subscribe(7);
  ctx.db.subscribe(8);
  ctx.db.subscribe(9);
  ctx.db.pushOff.add('9');
}

// --- Pure builder ----------------------------------------------------------

test('Eastern week math: previous week across DST, labels, Monday checks, cron window', () => {
  assert.equal(previousWeekStart(NOW), WEEK);
  // Monday 03:00 UTC is still Sunday evening in New York.
  assert.equal(
    previousWeekStart(Date.parse('2026-10-19T03:00:00Z')),
    '2026-10-05',
  );
  // First Monday after DST ends (Nov 1): both cron times map to Oct 26.
  assert.equal(
    previousWeekStart(Date.parse('2026-11-02T13:05:00Z')),
    '2026-10-26',
  );
  assert.equal(
    previousWeekStart(Date.parse('2026-11-02T14:05:00Z')),
    '2026-10-26',
  );
  // First Monday after DST starts (Mar 8, 2026).
  assert.equal(
    previousWeekStart(Date.parse('2026-03-09T13:05:00Z')),
    '2026-03-02',
  );

  // Labels and Monday validation.
  assert.equal(formatWeekLabel(WEEK), 'Oct 12–18');
  assert.equal(formatWeekLabel('2026-09-28'), 'Sep 28–Oct 4');
  assert.equal(formatWeekLabel('2026-12-28'), 'Dec 28–Jan 3');
  assert.equal(isWeekStart(WEEK), true);
  assert.equal(isWeekStart('2026-10-13'), false);
  assert.equal(isWeekStart('2026-02-30'), false);
  assert.equal(isWeekStart('nope'), false);

  // The cron script's send window is Monday at or after 9:00 ET.
  assert.equal(isSendWindow(Date.parse('2026-10-19T13:05:00Z')), true);
  assert.equal(isSendWindow(Date.parse('2026-10-19T12:55:00Z')), false);
  assert.equal(isSendWindow(Date.parse('2026-11-02T13:05:00Z')), false);
  assert.equal(isSendWindow(Date.parse('2026-11-02T14:05:00Z')), true);
  assert.equal(isSendWindow(Date.parse('2026-10-20T14:05:00Z')), false);
});

test('schedule summary counts only completed regular-season/playoff games in the week', () => {
  const summary = summarizeWeekSchedule(
    {
      gameWeek: [
        ...NORMAL_WEEK.gameWeek,
        { date: '2026-10-19', games: [scheduleGame(8, 'EDM', 'VAN')] },
        {
          date: '2026-10-15',
          games: [scheduleGame(5, 'SEA', 'VAN', 2, 'FUT')],
        },
        {
          date: '2026-10-15',
          games: [scheduleGame(6, 'SEA', 'LAK', 3, 'FINAL')],
        },
      ],
    },
    WEEK,
  );
  assert.equal(summary.leagueGames, 4);
  assert.equal(summary.gamesByTeam.EDM, 2);
  assert.equal(summary.gamesByTeam.TOR, 1);
  assert.equal(summary.gamesByTeam.MTL, undefined);
  assert.equal(summary.gamesByTeam.VAN, undefined);
  assert.equal(summarizeWeekSchedule(BREAK_WEEK, WEEK).leagueGames, 0);
  assert.equal(summarizeWeekSchedule(null, WEEK).leagueGames, 0);
});

function favoriteOf(playerId) {
  const [first, last, team, position] = PROFILES[playerId];
  return {
    playerId,
    name: `${first} ${last}`,
    teamTriCode: team,
    position,
    headshot: null,
  };
}

test('report lines: skater, goalie, did-not-play, headline', () => {
  const schedule = summarizeWeekSchedule(NORMAL_WEEK, WEEK);
  const report = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [MCDAVID, SKINNER, HUGHES, MATTHEWS].map(favoriteOf),
    skaterRows: normalizeGameRows([...SKATER_ROWS, SKATER_ROWS[1]], {
      playerIds: [MCDAVID, HUGHES, MATTHEWS],
      weekStart: WEEK,
    }),
    goalieRows: normalizeGameRows(GOALIE_ROWS, {
      playerIds: [SKINNER],
      weekStart: WEEK,
    }),
    schedule,
  });
  assert.equal(report.label, 'Oct 12–18');
  assert.equal(report.weekEnd, '2026-10-18');
  const [mcdavid, skinner, hughes, matthews] = report.players;
  assert.deepEqual(mcdavid.stats, {
    gp: 2,
    goals: 2,
    assists: 4,
    points: 6,
    plusMinus: 1,
    shots: 11,
    toiPerGame: '21:42',
    bestGame: { gameId: 1, text: '1G 3A vs CGY, Oct 14' },
  });
  assert.equal(mcdavid.type, 'skater');
  assert.deepEqual(skinner.stats, {
    gp: 1,
    wins: 1,
    losses: 0,
    otLosses: 0,
    record: '1-0-0',
    savePct: 0.938,
    gaa: 2,
    shutouts: 0,
  });
  assert.equal(skinner.type, 'goalie');
  assert.equal(hughes.played, false);
  assert.equal(hughes.teamGames, 0);
  assert.equal(hughes.stats, null);
  assert.equal(matthews.played, false);
  assert.equal(matthews.teamGames, 1);
  assert.equal(report.headline, 'Connor McDavid: 2G 4A in 2 GP and 1 more');
});

test('traded player, goalie-only and did-not-play headlines, and the per-user skip', () => {
  const schedule = summarizeWeekSchedule(NORMAL_WEEK, WEEK);
  const traded = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(MCDAVID)],
    skaterRows: [
      { ...SKATER_ROWS[0], teamAbbrev: 'CGY', opponentTeamAbbrev: undefined },
      SKATER_ROWS[1],
    ],
    goalieRows: [],
    schedule,
  });
  assert.deepEqual(traded.players[0].teams, ['CGY', 'EDM']);
  assert.equal(traded.players[0].team, 'EDM');
  // Opponent falls back to the schedule when the stats row lacks it.
  assert.equal(traded.players[0].stats.bestGame.text, '1G 3A vs EDM, Oct 14');

  const goalieOnly = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(SKINNER)],
    skaterRows: [],
    goalieRows: GOALIE_ROWS,
    schedule,
  });
  assert.equal(goalieOnly.headline, 'Stuart Skinner: 1-0-0 in 1 GP');

  const dnp = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(MATTHEWS)],
    skaterRows: [],
    goalieRows: [],
    schedule,
  });
  assert.equal(dnp.headline, 'Your favorite players did not play this week.');

  // No report when neither the favorites nor their teams played.
  assert.equal(
    buildWeeklyReport({
      weekStart: WEEK,
      favorites: [favoriteOf(HUGHES)],
      skaterRows: [],
      goalieRows: [],
      schedule: summarizeWeekSchedule(NORMAL_WEEK, WEEK),
    }),
    null,
  );
});

// --- Favorites -------------------------------------------------------------

test('favorite players: add, list, remove, validation, auth, and the cap of 10', async () => {
  const ctx = build();
  assert.equal(
    (await request(ctx.favorites, '/api/favorite-players')).status,
    401,
  );
  const added = await favorite(ctx, 7, MCDAVID);
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.favorites, [
    {
      playerId: MCDAVID,
      name: 'Connor McDavid',
      teamTriCode: 'EDM',
      position: 'C',
      headshot: `https://assets.example/${MCDAVID}.png`,
      since: added.body.favorites[0].since,
    },
  ]);
  assert.equal((await favorite(ctx, 7, 'abc')).status, 400);
  assert.equal((await favorite(ctx, 7, 1234)).status, 404);
  const favoritesResponse = await request(ctx.favorites, '/api/favorite-players', {
    headers: auth(7),
  });
  assert.equal(favoritesResponse.body.favorites.length, 1);
  const removed = await request(
    ctx.favorites,
    `/api/favorite-players/${MCDAVID}`,
    { method: 'DELETE', headers: auth(7) },
  );
  assert.deepEqual(removed.body, { favorites: [] });

  // Capped at 10; re-favoriting an existing player does not count.
  for (let id = 1; id <= 10; id += 1) {
    assert.equal((await favorite(ctx, 7, 9000000 + id)).status, 200);
  }
  const eleventh = await favorite(ctx, 7, 9000011);
  assert.equal(eleventh.status, 409);
  assert.match(eleventh.body.error, /at most 10/);
  assert.equal((await favorite(ctx, 7, 9000001)).status, 200);
  // Landing lookups are cached.
  await favorite(ctx, 7, 9000001);
  assert.equal(
    ctx.calls.nhl.filter((url) => url === '/player/9000001/landing').length,
    1,
  );
});

// --- Dispatch --------------------------------------------------------------

test('weekly dispatch requires the cron secret and config, and a completed Monday week', async () => {
  const ctx = build();
  const bad = await request(ctx.push, '/api/push/weekly-dispatch', {
    method: 'POST',
    headers: cron('wrong'),
  });
  assert.equal(bad.status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await weeklyDispatch(ctx)).status, 503);

  // A weekStart override must be a completed Monday week.
  process.env.CRON_SECRET = CRON;
  assert.equal(
    (await weeklyDispatch(ctx, { weekStart: '2026-10-13' })).status,
    400,
  );
  // The current week (Oct 19–25) is not finished yet.
  assert.equal(
    (await weeklyDispatch(ctx, { weekStart: '2026-10-19' })).status,
    400,
  );
  assert.equal((await weeklyDispatch(ctx, { weekStart: WEEK })).status, 200);
});

test('normal week: one batched NHL load, reports for active users, one push each, rerun-safe', async () => {
  const ctx = build();
  await seedUsers(ctx);
  const response = await weeklyDispatch(ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    weekStart: WEEK,
    created: 2,
    users: 1,
    sent: 1,
    removed: 0,
  });
  // User 8 (VAN only, no VAN games) gets nothing; user 9 has push off.
  assert.deepEqual([...ctx.db.reports.keys()].sort(), [
    `7:${WEEK}`,
    `9:${WEEK}`,
  ]);
  assert.equal(ctx.sent.length, 1);
  const { payload } = ctx.sent[0];
  assert.equal(payload.kind, 'weekly-report');
  assert.equal(payload.title, 'Weekly Player Report · Oct 12–18');
  assert.equal(payload.body, 'Connor McDavid: 2G 4A in 2 GP and 1 more');
  assert.equal(payload.weekStart, WEEK);
  assert.equal(payload.tag, `wpr-${WEEK}`);
  assert.deepEqual(sessionJwt.verifyWeeklyReadToken(payload.readToken), {
    userId: '7',
    weekStart: WEEK,
  });
  // One schedule call, one skater query, one goalie query for all users.
  assert.deepEqual(
    ctx.calls.nhl.filter((url) => url.startsWith('/schedule/')),
    [`/schedule/${WEEK}`],
  );
  assert.equal(ctx.calls.skaters.length, 1);
  assert.equal(ctx.calls.goalies.length, 1);
  const skaterQuery = decodeURIComponent(ctx.calls.skaters[0]);
  assert.match(skaterQuery, /isGame=true/);
  assert.match(skaterQuery, /gameDate>="2026-10-12"/);
  assert.match(skaterQuery, /gameDate<="2026-10-18 23:59:59"/);
  assert.match(skaterQuery, /gameTypeId in \(2,3\)/);
  assert.match(
    skaterQuery,
    new RegExp(`playerId in \\(${MCDAVID},${MATTHEWS},${HUGHES}\\)`),
  );
  assert.match(
    decodeURIComponent(ctx.calls.goalies[0]),
    new RegExp(`playerId in \\(${SKINNER}\\)`),
  );

  // A second run (or the DST twin) creates and sends nothing new, reusing
  // the week-keyed NHL payloads.
  const again = await weeklyDispatch(ctx);
  assert.deepEqual(again.body, {
    weekStart: WEEK,
    created: 0,
    users: 1,
    sent: 0,
    removed: 0,
  });
  assert.equal(ctx.sent.length, 1);
  // Raw NHL payloads came from the week-keyed cache.
  assert.equal(ctx.calls.skaters.length, 1);
});

test('break weeks and NHL failures create and send nothing', async () => {
  const ctx = build({ schedule: BREAK_WEEK });
  await seedUsers(ctx);
  const response = await weeklyDispatch(ctx);
  assert.deepEqual(response.body, {
    weekStart: WEEK,
    skipped: 'league-break',
    created: 0,
    users: 0,
    sent: 0,
    removed: 0,
  });
  assert.equal(ctx.db.reports.size, 0);
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.calls.skaters.length + ctx.calls.goalies.length, 0);

  // An NHL stats failure is a 502 with nothing written; a retry succeeds.
  const failing = build();
  await seedUsers(failing);
  failing.fail.stats = true;
  const failed = await weeklyDispatch(failing);
  assert.equal(failed.status, 502);
  assert.equal(failing.db.reports.size, 0);
  assert.equal(failing.db.ledger.size, 0);
  assert.equal(failing.sent.length, 0);
  failing.fail.stats = false;
  const retried = await weeklyDispatch(failing);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.sent, 1);
});

test('gone subscriptions are removed; read reports are not pushed', async () => {
  const ctx = build({
    sendImpl: async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    },
  });
  await seedUsers(ctx);
  const response = await weeklyDispatch(ctx);
  assert.equal(response.body.removed, 1);
  assert.equal(response.body.sent, 0);
  assert.equal(
    ctx.db.subs.some((subscription) => subscription.user_id === 7),
    false,
  );

  const ctx2 = build();
  await seedUsers(ctx2);
  await ctx2.db.withTransaction((client) =>
    client.query('INSERT INTO weekly_player_reports', [
      7,
      WEEK,
      json({ label: 'x', headline: 'y', players: [] }),
    ]),
  );
  await request(ctx2.reports, `/api/weekly-player-reports/${WEEK}/read`, {
    method: 'POST',
    headers: auth(7),
  });
  const second = await weeklyDispatch(ctx2);
  assert.equal(second.body.sent, 0);
});

// --- Inbox, read tokens, toggle -------------------------------------------

test('reports list, single report, read receipts, and the push read token', async () => {
  const ctx = build();
  await seedUsers(ctx);
  await weeklyDispatch(ctx);

  const reportsResponse = await request(ctx.reports, '/api/weekly-player-reports', {
    headers: auth(7),
  });
  assert.equal(reportsResponse.status, 200);
  assert.equal(reportsResponse.body.unreadCount, 1);
  assert.equal(reportsResponse.body.reports[0].weekStart, WEEK);
  assert.equal(reportsResponse.body.reports[0].label, 'Oct 12–18');
  assert.equal(reportsResponse.body.reports[0].players.length, 4);
  assert.equal(reportsResponse.body.reports[0].read, false);

  const single = await request(
    ctx.reports,
    `/api/weekly-player-reports/${WEEK}`,
    {
      headers: auth(7),
    },
  );
  assert.equal(single.body.players[0].name, 'Connor McDavid');
  assert.equal(
    (
      await request(ctx.reports, '/api/weekly-player-reports/2026-10-05', {
        headers: auth(7),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(ctx.reports, '/api/weekly-player-reports/2026-10-06', {
        headers: auth(7),
      })
    ).status,
    400,
  );

  const readToken = ctx.sent[0].payload.readToken;
  // A weekly read token is never a session token.
  assert.equal(
    (
      await request(ctx.reports, '/api/weekly-player-reports', {
        headers: { authorization: `Bearer ${readToken}` },
      })
    ).status,
    401,
  );
  assert.throws(() => sessionJwt.verifyReadToken(readToken));
  const read = await request(ctx.push, '/api/push/read', {
    method: 'POST',
    body: json({ token: readToken }),
  });
  assert.equal(read.status, 204);
  const after = await request(ctx.reports, '/api/weekly-player-reports', {
    headers: auth(7),
  });
  assert.equal(after.body.unreadCount, 0);
  // A session token is never a read token.
  const bad = await request(ctx.push, '/api/push/read', {
    method: 'POST',
    body: json({ token: auth(7).authorization.slice(7) }),
  });
  assert.equal(bad.status, 401);
});

test('weekly report push switch: get, set, validate', async () => {
  const ctx = build();
  const get = () =>
    request(ctx.push, '/api/push/weekly-report', { headers: auth(7) });
  assert.deepEqual((await get()).body, { enabled: true });
  const off = await request(ctx.push, '/api/push/weekly-report', {
    method: 'PUT',
    headers: auth(7),
    body: json({ enabled: false }),
  });
  assert.deepEqual(off.body, { enabled: false });
  assert.deepEqual((await get()).body, { enabled: false });
  const bad = await request(ctx.push, '/api/push/weekly-report', {
    method: 'PUT',
    headers: auth(7),
    body: json({ enabled: 'no' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await request(ctx.push, '/api/push/weekly-report')).status,
    401,
  );
});
