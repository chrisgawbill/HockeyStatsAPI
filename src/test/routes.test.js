const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

const { makeTestApp, request } = require('./testApp.js');

const CACHE_TYPES = {
  PLAYER: 'player',
  ROSTER: 'roster',
  AI: 'ai',
  SCHEDULE: 'schedule',
  STANDINGS: 'standings',
  STAT_LEADERS: 'stat-leaders',
  TEAM: 'team',
};

const cacheState = {
  calls: [],
  responses: new Map(),
  async getOrFetch(type, key, fetcher) {
    this.calls.push({ type, key });
    const responseKey = `${type}:${key}`;
    if (this.responses.has(responseKey)) {
      return this.responses.get(responseKey);
    }
    return fetcher();
  },
};

function setCacheResponse(type, key, data) {
  cacheState.responses.set(`${type}:${key}`, data);
}

function resetCacheState() {
  cacheState.calls = [];
  cacheState.responses = new Map();
}

function installCacheManagerMock() {
  const cachePath = require.resolve('#platform/cacheManager.js');
  delete require.cache[cachePath];
  require.cache[cachePath] = {
    id: cachePath,
    filename: cachePath,
    loaded: true,
    exports: {
      CACHE_TYPES,
      GetOrFetch: (...args) => cacheState.getOrFetch(...args),
      readCache: async () => null,
      writeCache: async () => {},
      getCacheStorageMode: () => 'filesystem',
      isCacheWritable: async () => true,
      isExternalCacheConfigured: async () => false,
      isExternalCacheReachable: async () => false,
      getCacheUsage: async () => ({
        sections: {},
        largestSection: null,
        total: 0,
      }),
    },
  };
}

installCacheManagerMock();

// Routers are built from the composition root so these tests exercise the same
// wiring the server uses; only the cache adapter is stubbed.
const { createContainer } = require('#composition/container.js');
const { createHealthRouter } = require('#presentation/routes/health.js');
const { createStandingsRouter } = require('#presentation/routes/standings.js');
const { createPlayerRouter } = require('#presentation/routes/player.js');
const { createTeamRouter } = require('#presentation/routes/team.js');
const { createScheduleRouter } = require('#presentation/routes/schedule.js');

const container = createContainer();
const healthRouter = createHealthRouter(container);
const standingsRouter = createStandingsRouter(container);
const playerRouter = createPlayerRouter(container);
const teamRouter = createTeamRouter(container);
const scheduleRouter = createScheduleRouter(container);

beforeEach(() => {
  resetCacheState();
  process.env.DIAGNOSTICS_PASSPHRASE = 'let-me-in';
  process.env.DISABLE_DOMAIN_PERSISTENCE = 'true';
});

test('health rejects requests without diagnostics key', async () => {
  const app = makeTestApp('/health', healthRouter);
  const response = await request(app, '/health');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'Unauthorized' });
});

test('health rejects requests with wrong diagnostics key', async () => {
  const app = makeTestApp('/health', healthRouter);
  const response = await request(app, '/health', {
    headers: { 'x-diagnostics-key': 'wrong' },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'Unauthorized' });
});

test('health accepts requests with correct diagnostics key', async () => {
  const app = makeTestApp('/health', healthRouter);
  const response = await request(app, '/health', {
    headers: { 'x-diagnostics-key': 'let-me-in' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.cacheWritable, true);
});

test('schedule uses season cache key and returns mapped games', async () => {
  setCacheResponse(CACHE_TYPES.SCHEDULE, '20232024', {
    gameWeek: [
      {
        date: '2024-01-01',
        dayAbbrev: 'Mon',
        games: [
          {
            id: 1,
            gameState: 'FUT',
            startTimeUTC: '2024-01-01T19:00:00Z',
            venue: { default: 'Ball Arena' },
            homeTeam: { abbrev: 'COL', logo: 'home.svg' },
            awayTeam: { abbrev: 'DAL', logo: 'away.svg' },
            ticketsLink: 'https://tickets.example',
          },
        ],
      },
    ],
  });

  const app = makeTestApp('/schedule', scheduleRouter);
  const response = await request(app, '/schedule?season=20232024');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.SCHEDULE, key: '20232024' },
  ]);
  assert.equal(response.body.games.length, 1);
  assert.equal(response.body.games[0].gameId, 1);
  assert.equal(response.body.games[0].homeTeam, 'COL');
  assert.equal(response.body.games[0].ticketLink, 'https://tickets.example');
});

test('schedule rejects invalid season before cache lookup', async () => {
  const app = makeTestApp('/schedule', scheduleRouter);
  const response = await request(app, '/schedule?season=bad');

  assert.equal(response.status, 400);
  assert.equal(cacheState.calls.length, 0);
  assert.match(response.body.error, /Invalid season format/);
});

test('schedule landing uses game landing cache key', async () => {
  setCacheResponse(CACHE_TYPES.SCHEDULE, 'landing_2023020001', {
    id: 2023020001,
    gameState: 'FINAL',
  });

  const app = makeTestApp('/schedule', scheduleRouter);
  const response = await request(app, '/schedule/landing/2023020001');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.SCHEDULE, key: 'landing_2023020001' },
  ]);
  assert.deepEqual(response.body, {
    id: 2023020001,
    gameState: 'FINAL',
  });
});

test('schedule boxscore uses game boxscore cache key', async () => {
  setCacheResponse(CACHE_TYPES.SCHEDULE, 'boxscore_2023020001', {
    id: 2023020001,
    homeTeam: { score: 4 },
  });

  const app = makeTestApp('/schedule', scheduleRouter);
  const response = await request(app, '/schedule/2023020001');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.SCHEDULE, key: 'boxscore_2023020001' },
  ]);
  assert.equal(response.body.homeTeam.score, 4);
});

test('standings uses season cache key and returns mapped standings', async () => {
  setCacheResponse(CACHE_TYPES.STANDINGS, '20232024', {
    standings: [
      {
        teamAbbrev: { default: 'COL' },
        teamLogo: 'logo.svg',
        teamCommonName: { default: 'Avalanche' },
        conferenceName: 'Western',
        divisionName: 'Central',
        wins: 50,
        losses: 20,
        otLosses: 5,
        points: 105,
        clinchIndicator: 'x',
      },
    ],
  });

  const app = makeTestApp('/standings', standingsRouter);
  const response = await request(app, '/standings?season=20232024');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.STANDINGS, key: '20232024' },
  ]);
  assert.equal(response.body.standings[0].teamId, 'COL');
  assert.equal(response.body.standings[0].clinchingIndicator, 'x');
});

test('skater stat leaders cache key includes category and season', async () => {
  setCacheResponse(CACHE_TYPES.STAT_LEADERS, 'skater_goals_20232024', {
    goals: [{ id: 7, firstName: { default: 'Cale' }, value: 42 }],
  });

  const app = makeTestApp('/player', playerRouter);
  const response = await request(
    app,
    '/player/skater/statLeaders/goals?season=20232024',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.STAT_LEADERS, key: 'skater_goals_20232024' },
  ]);
  assert.equal(response.body[0].id, 7);
  assert.equal(response.body[0].value, 42);
});

test('goalie stat leaders cache key includes category and season', async () => {
  setCacheResponse(CACHE_TYPES.STAT_LEADERS, 'goalie_savePctg_20232024', {
    savePctg: [{ id: 35, lastName: { default: 'Goalie' }, value: 0.925 }],
  });

  const app = makeTestApp('/player', playerRouter);
  const response = await request(
    app,
    '/player/goalie/statLeaders/savePctg?season=20232024',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.STAT_LEADERS, key: 'goalie_savePctg_20232024' },
  ]);
  assert.equal(response.body[0].id, 35);
  assert.equal(response.body[0].value, 0.925);
});

test('skater summary cache key includes team and season', async () => {
  setCacheResponse(CACHE_TYPES.PLAYER, 'skater_summary_10_20232024', {
    data: [{ playerId: 29, skaterFullName: 'Nathan MacKinnon', goals: 51 }],
  });

  const app = makeTestApp('/player', playerRouter);
  const response = await request(
    app,
    '/player/skater/summary?teamId=10&season=20232024',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.PLAYER, key: 'skater_summary_10_20232024' },
  ]);
  assert.equal(response.body[0].playerId, 29);
  assert.equal(response.body[0].goals, 51);
});

test('skater corsi cache key includes team and season', async () => {
  setCacheResponse(CACHE_TYPES.PLAYER, 'skater_corsi_10_20232024', {
    data: [{ playerId: 29, satPct: 55.1 }],
  });

  const app = makeTestApp('/player', playerRouter);
  const response = await request(
    app,
    '/player/skater/corsi?teamId=10&season=20232024',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.PLAYER, key: 'skater_corsi_10_20232024' },
  ]);
  assert.deepEqual(response.body, { data: [{ playerId: 29, satPct: 55.1 }] });
});

test('goalie summary cache key includes team and season', async () => {
  setCacheResponse(CACHE_TYPES.PLAYER, 'goalie_summary_10_20232024', {
    data: [{ goalieId: 35, goalieFullName: 'Goalie Name', wins: 30 }],
  });

  const app = makeTestApp('/player', playerRouter);
  const response = await request(
    app,
    '/player/goalie/summary?teamId=10&season=20232024',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.PLAYER, key: 'goalie_summary_10_20232024' },
  ]);
  assert.equal(response.body[0].goalieId, 35);
  assert.equal(response.body[0].wins, 30);
});

test('team roster cache key includes team and season', async () => {
  setCacheResponse(CACHE_TYPES.ROSTER, 'COL_20232024', {
    forwards: [
      {
        id: 29,
        firstName: { default: 'Nathan' },
        lastName: { default: 'MacKinnon' },
        sweaterNumber: 29,
        positionCode: 'C',
      },
    ],
  });

  const app = makeTestApp('/team', teamRouter);
  const response = await request(app, '/team/roster/COL?season=20232024');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.ROSTER, key: 'COL_20232024' },
  ]);
  assert.equal(response.body.players[0].id, 29);
  assert.equal(response.body.players[0].name, 'Nathan MacKinnon');
});

test('team schedule cache key includes team and season', async () => {
  setCacheResponse(CACHE_TYPES.SCHEDULE, 'team_COL_20232024', {
    games: [
      {
        id: 2023020001,
        gameDate: '2024-01-01',
        gameState: 'FUT',
        startTimeUTC: '2024-01-01T19:00:00Z',
        venue: { default: 'Ball Arena' },
        homeTeam: { abbrev: 'COL', logo: 'home.svg' },
        awayTeam: { abbrev: 'DAL', logo: 'away.svg' },
      },
    ],
  });

  const app = makeTestApp('/team', teamRouter);
  const response = await request(app, '/team/schedule/COL?season=20232024');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.SCHEDULE, key: 'team_COL_20232024' },
  ]);
  assert.equal(response.body.games[0].gameId, 2023020001);
  assert.equal(response.body.games[0].homeTeam, 'COL');
});

test('single team stats cache key includes team and season', async () => {
  setCacheResponse(CACHE_TYPES.TEAM, 'summary_21_20232024', {
    data: [{ teamId: 21, wins: 50 }],
  });

  const app = makeTestApp('/team', teamRouter);
  const response = await request(app, '/team/21?season=20232024');

  assert.equal(response.status, 200);
  assert.deepEqual(cacheState.calls, [
    { type: CACHE_TYPES.TEAM, key: 'summary_21_20232024' },
  ]);
  assert.equal(response.body.data[0].wins, 50);
});
