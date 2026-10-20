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

function setCacheResponse(type, key, payload) {
  cacheState.responses.set(`${type}:${key}`, payload);
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
      getOrFetchCached: (...args) => cacheState.getOrFetch(...args),
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

/**
 * Requests `path` with `payload` cached under (type, key) and asserts that the
 * route looked up exactly that key and answered 200. Returns the body.
 */
async function getCached(router, mount, path, [type, key], payload) {
  resetCacheState();
  setCacheResponse(type, key, payload);
  const response = await request(makeTestApp(mount, router), path);
  assert.equal(response.status, 200, path);
  assert.deepEqual(cacheState.calls, [{ type, key }], path);
  return response.body;
}

test('health requires the correct diagnostics key', async () => {
  const app = makeTestApp('/health', healthRouter);
  for (const headers of [{}, { 'x-diagnostics-key': 'wrong' }]) {
    const response = await request(app, '/health', { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Unauthorized' });
  }

  const response = await request(app, '/health', {
    headers: { 'x-diagnostics-key': 'let-me-in' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.cacheWritable, true);
});

test('schedule routes use season, landing, and boxscore cache keys', async () => {
  const schedule = await getCached(
    scheduleRouter,
    '/schedule',
    '/schedule?season=20232024',
    [CACHE_TYPES.SCHEDULE, '20232024'],
    {
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
    },
  );
  assert.equal(schedule.games.length, 1);
  assert.equal(schedule.games[0].gameId, 1);
  assert.equal(schedule.games[0].homeTeam, 'COL');
  assert.equal(schedule.games[0].ticketLink, 'https://tickets.example');

  const landing = { id: 2023020001, gameState: 'FINAL' };
  assert.deepEqual(
    await getCached(
      scheduleRouter,
      '/schedule',
      '/schedule/landing/2023020001',
      [CACHE_TYPES.SCHEDULE, 'landing_2023020001'],
      landing,
    ),
    landing,
  );
  const boxscore = await getCached(
    scheduleRouter,
    '/schedule',
    '/schedule/2023020001',
    [CACHE_TYPES.SCHEDULE, 'boxscore_2023020001'],
    { id: 2023020001, homeTeam: { score: 4 } },
  );
  assert.equal(boxscore.homeTeam.score, 4);

  // An invalid season is rejected before any cache lookup.
  resetCacheState();
  const bad = await request(
    makeTestApp('/schedule', scheduleRouter),
    '/schedule?season=bad',
  );
  assert.equal(bad.status, 400);
  assert.equal(cacheState.calls.length, 0);
  assert.match(bad.body.error, /Invalid season format/);
});

test('standings uses the season cache key and maps standings', async () => {
  const body = await getCached(
    standingsRouter,
    '/standings',
    '/standings?season=20232024',
    [CACHE_TYPES.STANDINGS, '20232024'],
    {
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
    },
  );
  assert.equal(body.standings[0].teamId, 'COL');
  assert.equal(body.standings[0].clinchingIndicator, 'x');
});

test('player routes key caches by category or team, and season', async () => {
  const get = (path, cacheKey, payload) =>
    getCached(playerRouter, '/player', path, cacheKey, payload);

  const skaterLeaders = await get(
    '/player/skater/statLeaders/goals?season=20232024',
    [CACHE_TYPES.STAT_LEADERS, 'skater_goals_20232024'],
    { goals: [{ id: 7, firstName: { default: 'Cale' }, value: 42 }] },
  );
  assert.equal(skaterLeaders[0].id, 7);
  assert.equal(skaterLeaders[0].value, 42);

  const goalieLeaders = await get(
    '/player/goalie/statLeaders/savePctg?season=20232024',
    [CACHE_TYPES.STAT_LEADERS, 'goalie_savePctg_20232024'],
    { savePctg: [{ id: 35, lastName: { default: 'Goalie' }, value: 0.925 }] },
  );
  assert.equal(goalieLeaders[0].id, 35);
  assert.equal(goalieLeaders[0].value, 0.925);

  const skaters = await get(
    '/player/skater/summary?teamId=10&season=20232024',
    [CACHE_TYPES.PLAYER, 'skater_summary_10_20232024'],
    { data: [{ playerId: 29, skaterFullName: 'Nathan MacKinnon', goals: 51 }] },
  );
  assert.equal(skaters[0].playerId, 29);
  assert.equal(skaters[0].goals, 51);

  const corsi = { data: [{ playerId: 29, satPct: 55.1 }] };
  assert.deepEqual(
    await get(
      '/player/skater/corsi?teamId=10&season=20232024',
      [CACHE_TYPES.PLAYER, 'skater_corsi_10_20232024'],
      corsi,
    ),
    corsi,
  );

  const goalies = await get(
    '/player/goalie/summary?teamId=10&season=20232024',
    [CACHE_TYPES.PLAYER, 'goalie_summary_10_20232024'],
    { data: [{ goalieId: 35, goalieFullName: 'Goalie Name', wins: 30 }] },
  );
  assert.equal(goalies[0].goalieId, 35);
  assert.equal(goalies[0].wins, 30);
});

test('team routes key caches by team and season', async () => {
  const get = (path, cacheKey, payload) =>
    getCached(teamRouter, '/team', path, cacheKey, payload);

  const roster = await get(
    '/team/roster/COL?season=20232024',
    [CACHE_TYPES.ROSTER, 'COL_20232024'],
    {
      forwards: [
        {
          id: 29,
          firstName: { default: 'Nathan' },
          lastName: { default: 'MacKinnon' },
          sweaterNumber: 29,
          positionCode: 'C',
        },
      ],
    },
  );
  assert.equal(roster.players[0].id, 29);
  assert.equal(roster.players[0].name, 'Nathan MacKinnon');

  const schedule = await get(
    '/team/schedule/COL?season=20232024',
    [CACHE_TYPES.SCHEDULE, 'team_COL_20232024'],
    {
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
    },
  );
  assert.equal(schedule.games[0].gameId, 2023020001);
  assert.equal(schedule.games[0].homeTeam, 'COL');

  const stats = await get(
    '/team/21?season=20232024',
    [CACHE_TYPES.TEAM, 'summary_21_20232024'],
    { data: [{ teamId: 21, wins: 50 }] },
  );
  assert.equal(stats.data[0].wins, 50);
});
