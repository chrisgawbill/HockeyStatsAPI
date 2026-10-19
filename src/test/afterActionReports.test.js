const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');
const jwt = require('jsonwebtoken');

const { makeTestApp, request } = require('./testApp.js');
const {
  buildAfterActionReports,
  createAfterActionReportService,
  mergeTeamGames,
} = require('#slices/afterActionReports/afterActionReportService.js');
const {
  createAfterActionReportsRouter,
  createFavoritesRouter,
} = require('#presentation/routes/afterActionReports.js');

const SECRET = 'test-session-secret';

beforeEach(() => {
  process.env.SESSION_JWT_SECRET = SECRET;
});

function authHeaders(userId = 7) {
  return {
    authorization: `Bearer ${jwt.sign({ userId }, SECRET, { expiresIn: '1h' })}`,
  };
}

function game(overrides) {
  return {
    gameId: 1,
    date: '2026-10-18',
    gameTime: '2026-10-18T23:00:00Z',
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

test('buildAfterActionReports reports completed games since favoriting, newest first, capped', () => {
  const { reports, unreadCount } = buildAfterActionReports({
    favorites: [{ triCode: 'TOR', since: '2026-10-15T18:30:00.000Z' }],
    gamesByTeam: {
      TOR: [
        game({ gameId: 1, date: '2026-10-14', gameTime: '2026-10-14T23:00:00Z' }),
        game({ gameId: 2, date: '2026-10-15', gameTime: '2026-10-15T23:00:00Z' }),
        game({ gameId: 3, date: '2026-10-18', gameTime: '2026-10-18T23:00:00Z', gameState: 'FINAL' }),
        game({ gameId: 4, date: '2026-10-19', gameTime: '2026-10-19T23:00:00Z', gameState: 'LIVE' }),
        game({ gameId: 5, date: '2026-10-21', gameTime: '2026-10-21T23:00:00Z', gameState: 'FUT' }),
      ],
    },
    readGameIds: [2],
  });

  assert.deepEqual(
    reports.map((r) => [r.gameId, r.read]),
    [
      [3, false],
      [2, true],
    ],
  );
  assert.equal(unreadCount, 1);

  // Favorited at 8:30pm Eastern (already Oct 19 UTC): tonight's game still
  // counts, last night's does not.
  const favorites = [{ triCode: 'TOR', since: '2026-10-19T00:30:00.000Z' }];
  const tonight = game({ gameId: 1, date: '2026-10-18', gameTime: '2026-10-18T23:00:00Z' });
  const lastNight = game({ gameId: 2, date: '2026-10-17', gameTime: '2026-10-17T23:00:00Z' });

  const { reports: late } = buildAfterActionReports({
    favorites,
    gamesByTeam: { TOR: [tonight, lastNight] },
    readGameIds: [],
  });

  assert.deepEqual(
    late.map((r) => r.gameId),
    [1],
  );

  // The inbox is capped and keeps the newest.
  const games = Array.from({ length: 30 }, (_, i) =>
    game({ gameId: i + 1, date: `2026-11-${String(i + 1).padStart(2, '0')}` }),
  );
  const { reports: capped } = buildAfterActionReports({
    favorites: [{ triCode: 'TOR', since: '2026-10-01T00:00:00.000Z' }],
    gamesByTeam: { TOR: games },
    readGameIds: [],
    limit: 25,
  });

  assert.equal(capped.length, 25);
  assert.equal(capped[0].gameId, 30);
});


test('a game between two favorites is one report; recent copies override season copies', () => {
  const shared = game({ gameId: 9 });
  const { reports } = buildAfterActionReports({
    favorites: [
      { triCode: 'TOR', since: '2026-10-01T00:00:00.000Z' },
      { triCode: 'MTL', since: '2026-10-01T00:00:00.000Z' },
    ],
    gamesByTeam: { TOR: [shared], MTL: [shared] },
    readGameIds: [],
  });

  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].favoriteTeams, ['TOR', 'MTL']);

  // mergeTeamGames prefers the fresher recent copy of a game.
  const merged = mergeTeamGames(
    [game({ gameId: 1, gameState: 'LIVE' }), game({ gameId: 2 })],
    [game({ gameId: 1, gameState: 'OFF' })],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged.find((g) => g.gameId === 1).gameState, 'OFF');
});



/** In-memory stand-in for the two tables, driven through the real repository SQL shape. */
function fakeStore() {
  const favorites = [];
  const reads = new Set();
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT team_tri_code')) {
        return {
          rows: favorites
            .filter((f) => f.user_id === params[0])
            .map((f) => ({ ...f })),
        };
      }
      if (sql.includes('INSERT INTO favorite_teams')) {
        if (
          !favorites.some(
            (f) => f.user_id === params[0] && f.team_tri_code === params[1],
          )
        ) {
          favorites.push({
            user_id: params[0],
            team_tri_code: params[1],
            created_at: '2026-10-10T12:00:00.000Z',
          });
        }
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM favorite_teams')) {
        const index = favorites.findIndex(
          (f) => f.user_id === params[0] && f.team_tri_code === params[1],
        );
        if (index >= 0) favorites.splice(index, 1);
        return { rows: [] };
      }
      if (sql.includes('SELECT game_id')) {
        return {
          rows: params[1]
            .filter((id) => reads.has(`${params[0]}:${id}`))
            .map((game_id) => ({ game_id: String(game_id) })),
        };
      }
      if (sql.includes('INSERT INTO after_action_report_reads')) {
        for (const id of params[1]) reads.add(`${params[0]}:${id}`);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { withTransaction: (fn) => fn(client), favorites, reads };
}

function buildService({ scheduleService } = {}) {
  const store = fakeStore();
  const service = createAfterActionReportService({
    withTransaction: store.withTransaction,
    seasons: { getCurrentSeasonId: () => '20262027' },
    scheduleService: scheduleService ?? {
      getTeamSchedule: async () => ({
        games: [game({ gameId: 11, date: '2026-10-12' })],
      }),
      getRecentTeamGames: async () => ({
        games: [game({ gameId: 12, date: '2026-10-18' })],
      }),
    },
  });
  return { service, store };
}

test('service favorites round-trip with tri-code validation, and reports track read state', async () => {
  const { service } = buildService();

  const added = await service.addFavorite(7, 'tor');
  assert.deepEqual(
    added.favorites.map((f) => f.triCode),
    ['TOR'],
  );
  await service.addFavorite(7, 'TOR');
  assert.equal((await service.listFavorites(7)).length, 1);

  await assert.rejects(service.addFavorite(7, 'TORONTO'), { status: 400 });


  // Reports carry read state and can be marked read one by one or all at once.

  let inbox = await service.listReports(7);
  assert.deepEqual(
    inbox.reports.map((r) => r.gameId),
    [12, 11],
  );
  assert.equal(inbox.unreadCount, 2);

  await service.markRead(7, '12');
  inbox = await service.listReports(7);
  assert.equal(inbox.unreadCount, 1);
  assert.equal(inbox.reports.find((r) => r.gameId === 12).read, true);

  const all = await service.markAllRead(7);
  assert.equal(all.unreadCount, 0);
  assert.equal((await service.listReports(7)).unreadCount, 0);

  await assert.rejects(service.markRead(7, 'abc'), { status: 400 });

  const removed = await service.removeFavorite(7, 'TOR');
  assert.deepEqual(removed.favorites, []);
});


test('service returns an empty inbox without favorites and survives a failed team', async () => {
  const { service } = buildService({
    scheduleService: {
      getTeamSchedule: async (triCode) => {
        if (triCode === 'BOS') throw new Error('NHL down');
        return { games: [game({ gameId: 21 })] };
      },
      getRecentTeamGames: async (triCode) => {
        if (triCode === 'BOS') throw new Error('NHL down');
        return { games: [] };
      },
    },
  });

  assert.deepEqual(await service.listReports(7), {
    reports: [],
    unreadCount: 0,
  });

  await service.addFavorite(7, 'BOS');
  await service.addFavorite(7, 'TOR');
  const inbox = await service.listReports(7);
  assert.deepEqual(
    inbox.reports.map((r) => r.gameId),
    [21],
  );
});

test('favorites and report routes require a session', async () => {
  const neverCalled = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('should not be called without auth');
      },
    },
  );

  const favorites = makeTestApp(
    '/api/favorites',
    createFavoritesRouter({ afterActionReportService: neverCalled }),
  );
  const reports = makeTestApp(
    '/api/after-action-reports',
    createAfterActionReportsRouter({ afterActionReportService: neverCalled }),
  );

  assert.equal((await request(favorites, '/api/favorites')).status, 401);
  assert.equal(
    (await request(reports, '/api/after-action-reports')).status,
    401,
  );
});

test('routes pass the session user through to the service', async () => {
  const calls = [];
  const afterActionReportService = {
    listFavorites: async (userId) => {
      calls.push(['list', userId]);
      return [];
    },
    addFavorite: async (userId, triCode) => {
      calls.push(['add', userId, triCode]);
      return { favorites: [{ triCode, since: 'x' }] };
    },
    removeFavorite: async (userId, triCode) => {
      calls.push(['remove', userId, triCode]);
      return { favorites: [] };
    },
    listReports: async (userId) => {
      calls.push(['reports', userId]);
      return { reports: [], unreadCount: 0 };
    },
    markRead: async (userId, gameId) => {
      calls.push(['read', userId, gameId]);
    },
    markAllRead: async (userId) => {
      calls.push(['readAll', userId]);
      return { reports: [], unreadCount: 0 };
    },
  };
  const favorites = makeTestApp(
    '/api/favorites',
    createFavoritesRouter({ afterActionReportService }),
  );
  const reports = makeTestApp(
    '/api/after-action-reports',
    createAfterActionReportsRouter({ afterActionReportService }),
  );
  const headers = authHeaders(7);

  assert.deepEqual((await request(favorites, '/api/favorites', { headers })).body, {
    favorites: [],
  });
  assert.equal(
    (
      await request(favorites, '/api/favorites/TOR', {
        method: 'PUT',
        headers,
      })
    ).body.favorites[0].triCode,
    'TOR',
  );
  await request(favorites, '/api/favorites/TOR', { method: 'DELETE', headers });
  await request(reports, '/api/after-action-reports', { headers });
  const readResponse = await request(
    reports,
    '/api/after-action-reports/2026020001/read',
    { method: 'POST', headers },
  );
  assert.equal(readResponse.status, 204);
  await request(reports, '/api/after-action-reports/read-all', {
    method: 'POST',
    headers,
  });

  assert.deepEqual(calls, [
    ['list', 7],
    ['add', 7, 'TOR'],
    ['remove', 7, 'TOR'],
    ['reports', 7],
    ['read', 7, '2026020001'],
    ['readAll', 7],
  ]);
});

