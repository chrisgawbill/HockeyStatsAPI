const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createScheduleService,
} = require('#slices/schedule/scheduleService.js');

const CACHE_TYPES = { SCHEDULE: 'schedule' };

/** Cache stub that always calls through to the fetcher (no persistence). */
const passthroughCache = {
  CACHE_TYPES,
  getOrFetchCached: (type, key, fetcher) => fetcher(),
  writeCache: async () => {},
};

const noopRunServiceTask = () => null;

/** Records every NHL weekly-schedule date requested; returns an empty week. */
function makeRecordingAxios() {
  const requestedDates = [];
  return {
    requestedDates,
    get: async (url) => {
      const match = url.match(/^\/schedule\/(\d{4}-\d{2}-\d{2})$/);
      if (match) requestedDates.push(match[1]);
      return { data: { gameWeek: [] } };
    },
  };
}

function makeService(axiosGet, currentSeasonId) {
  return createScheduleService({
    nhlApi: { axiosNhl: axiosGet },
    cache: passthroughCache,
    seasons: { getCurrentSeasonId: () => currentSeasonId },
    runServiceTask: noopRunServiceTask,
  });
}

test('getSeasonSchedule walks Sept 1 - next June 30 for current and past seasons alike', async () => {
  const lastWeekOf = (dates) => dates[dates.length - 1];
  const current = makeRecordingAxios();
  await makeService(current, '20262027').getSeasonSchedule('20262027');
  assert.equal(current.requestedDates[0], '2026-09-01');
  // Weekly steps of 7 days from Sept 1 land within the final week of June.
  const last = lastWeekOf(current.requestedDates);
  assert.ok(last >= '2027-06-24' && last <= '2027-06-30', `got ${last}`);

  const past = makeRecordingAxios();
  await makeService(past, '20262027').getSeasonSchedule('20242025');
  assert.equal(past.requestedDates[0], '2024-09-01');
  const pastLast = lastWeekOf(past.requestedDates);
  assert.ok(pastLast >= '2025-06-24' && pastLast <= '2025-06-30');

  // The range does not depend on whether the season is current.
  const notCurrent = makeRecordingAxios();
  await makeService(notCurrent, '20999999').getSeasonSchedule('20262027');
  assert.deepEqual(notCurrent.requestedDates, current.requestedDates);
});

/** Cache stub holding one stored entry; records the TTL each read asks for. */
function makeStoredCache(stored) {
  const calls = { reads: [], fetches: 0 };
  return {
    calls,
    cache: {
      CACHE_TYPES,
      readCache: async (type, key, options) => {
        calls.reads.push(options.ttlMs);
        return stored;
      },
      getOrFetchCached: async (type, key, fetcher, options) => {
        calls.reads.push(options.ttlMs);
        calls.fetches += 1;
        return fetcher();
      },
      writeCache: async () => {},
    },
  };
}

function makeGamecenterService(cache, nhlPayload) {
  return createScheduleService({
    nhlApi: { axiosNhl: { get: async () => ({ data: nhlPayload }) } },
    cache,
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: noopRunServiceTask,
  });
}

test('gamecenter payloads are served from cache forever once the game is OFF', async () => {
  const official = { id: 1, gameState: 'OFF' };
  const { cache, calls } = makeStoredCache(official);
  const service = makeGamecenterService(cache, { id: 1, gameState: 'LIVE' });
  assert.deepEqual(await service.getGameBoxscore(1), official);
  assert.deepEqual(await service.getGameLanding(1), official);
  assert.equal(calls.fetches, 0);
  assert.deepEqual(calls.reads, [Infinity, Infinity]);
});

test('gamecenter payloads for unfinished games use the 5-minute cache', async () => {
  for (const gameState of ['LIVE', 'FINAL']) {
    const { cache, calls } = makeStoredCache({ id: 1, gameState });
    const fresh = { id: 1, gameState: 'OFF' };
    const service = makeGamecenterService(cache, fresh);
    assert.deepEqual(await service.getGameBoxscore(1), fresh);
    assert.equal(calls.fetches, 1);
    assert.deepEqual(calls.reads, [Infinity, 5 * 60 * 1000]);
  }
});

test('play-by-play is cached raw: forever once OFF, 1 minute while live, else 5 minutes', async () => {
  const official = { id: 1, gameState: 'OFF', plays: [] };
  const offCache = makeStoredCache(official);
  const offService = makeGamecenterService(offCache.cache, null);
  assert.equal((await offService.getGamePlayByPlay(1)).gameState, 'OFF');
  assert.equal(offCache.calls.fetches, 0);

  const expectedTtlByCachedState = {
    LIVE: 60 * 1000,
    CRIT: 60 * 1000,
    FUT: 5 * 60 * 1000,
    FINAL: 5 * 60 * 1000,
  };
  for (const [gameState, ttlMs] of Object.entries(expectedTtlByCachedState)) {
    const { cache, calls } = makeStoredCache({ id: 1, gameState, plays: [] });
    const service = makeGamecenterService(cache, {
      id: 1,
      gameState: 'LIVE',
      plays: [],
    });
    const mapped = await service.getGamePlayByPlay(1);
    assert.equal(mapped.gameState, 'LIVE');
    assert.deepEqual(mapped.events, []);
    assert.deepEqual(calls.reads, [Infinity, ttlMs], gameState);
  }
});

test('getClubSeason maps the club season with its name and logo; fresh skips the cached copy', async () => {
  const clubSchedulePayload = {
    games: [
      {
        id: 2026020001,
        gameType: 2,
        gameDate: '2026-10-14',
        gameState: 'OFF',
        awayTeam: { abbrev: 'CGY', score: 3 },
        homeTeam: {
          abbrev: 'EDM',
          score: 4,
          placeName: { default: 'Edmonton' },
          commonName: { default: 'Oilers' },
          logo: 'https://assets.nhle.com/logos/nhl/svg/EDM_light.svg',
        },
        periodDescriptor: { periodType: 'OT' },
      },
    ],
  };
  const requests = [];
  const service = createScheduleService({
    nhlApi: {
      axiosNhl: {
        get: async (url) => {
          requests.push(url);
          return { data: clubSchedulePayload };
        },
      },
    },
    cache: {
      CACHE_TYPES,
      getOrFetchCached: async (type, key, fetcher, options) => {
        requests.push(`${key} ttl=${options.ttlMs}`);
        return fetcher();
      },
    },
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: noopRunServiceTask,
  });

  const clubSeason = await service.getClubSeason('EDM', '20262027');
  assert.deepEqual(clubSeason.team, {
    name: 'Edmonton Oilers',
    logo: 'https://assets.nhle.com/logos/nhl/svg/EDM_light.svg',
  });
  assert.equal(clubSeason.games.length, 1);
  assert.equal(clubSeason.games[0].homeScore, 4);
  assert.equal(clubSeason.games[0].periodType, 'OT');
  await service.getClubSeason('EDM', '20262027', { fresh: true });
  assert.deepEqual(requests, [
    'team_EDM_20262027 ttl=undefined',
    '/club-schedule-season/EDM/20262027',
    'team_EDM_20262027 ttl=0',
    '/club-schedule-season/EDM/20262027',
  ]);

  // A team missing from its own schedule falls back to the tri-code.
  assert.deepEqual(
    (await service.getClubSeason('XYZ', '20262027')).team,
    { name: 'XYZ', logo: null },
  );
});

/** One raw weekly-schedule game between EDM (home) and CGY. */
function makeWeeklyGame(id, gameState, startTimeUTC, scores = {}) {
  return {
    id,
    gameState,
    startTimeUTC,
    gameType: 2,
    ticketsLink: 'https://tickets.example/',
    homeTeam: { abbrev: 'EDM', score: scores.home },
    awayTeam: { abbrev: 'CGY', score: scores.away },
  };
}

/** Season-schedule service over a cache holding `seasonGames` plus `storedPayloads` by key. */
function makeSeasonService(seasonGames, storedPayloads) {
  const readKeys = [];
  const service = createScheduleService({
    nhlApi: { axiosNhl: { get: async () => ({ data: null }) } },
    cache: {
      CACHE_TYPES,
      getOrFetchCached: async () => ({
        gameWeek: [{ date: '2026-10-27', dayAbbrev: 'TUE', games: seasonGames }],
      }),
      readCache: async (type, key, options) => {
        readKeys.push(`${key} ttl=${options.ttlMs}`);
        return storedPayloads[key] ?? null;
      },
      writeCache: async () => {},
    },
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: noopRunServiceTask,
  });
  return { service, readKeys };
}

const STARTED = '2020-01-01T00:00:00Z';
const UPCOMING = '2999-01-01T00:00:00Z';

test('getSeasonSchedule marks a started game final from its cached boxscore', async () => {
  const { service } = makeSeasonService([makeWeeklyGame(1, 'FUT', STARTED)], {
    boxscore_1: {
      id: 1,
      gameState: 'OFF',
      homeTeam: { score: 3 },
      awayTeam: { score: 2 },
      periodDescriptor: { periodType: 'OT' },
    },
    landing_1: { id: 1, gameState: 'LIVE', homeTeam: { score: 2 }, awayTeam: { score: 2 } },
  });
  const [game] = (await service.getSeasonSchedule('20262027')).games;
  assert.equal(game.gameState, 'OFF');
  assert.equal(game.homeScore, 3);
  assert.equal(game.awayScore, 2);
  assert.equal(game.periodType, 'OT');
  assert.equal(game.ticketLink, '');
});

test('getSeasonSchedule marks a started game live from a cached club week, keeping the later score', async () => {
  const { service } = makeSeasonService([makeWeeklyGame(1, 'FUT', STARTED)], {
    landing_1: { id: 1, gameState: 'LIVE', homeTeam: { score: 0 }, awayTeam: { score: 1 } },
    team_EDM_week_now: {
      games: [makeWeeklyGame(1, 'LIVE', STARTED, { home: 2, away: 1 })],
    },
  });
  const [game] = (await service.getSeasonSchedule('20262027')).games;
  assert.equal(game.gameState, 'LIVE');
  assert.equal(game.homeScore, 2);
  assert.equal(game.awayScore, 1);
});

test('getSeasonSchedule never moves a game backwards and leaves unstarted and official games alone', async () => {
  const { service, readKeys } = makeSeasonService(
    [
      makeWeeklyGame(1, 'FINAL', STARTED, { home: 4, away: 1 }),
      makeWeeklyGame(2, 'OFF', STARTED, { home: 1, away: 0 }),
      makeWeeklyGame(3, 'FUT', UPCOMING),
    ],
    {
      boxscore_1: { id: 1, gameState: 'LIVE', homeTeam: { score: 3 }, awayTeam: { score: 1 } },
      boxscore_3: { id: 3, gameState: 'LIVE' },
    },
  );
  const games = (await service.getSeasonSchedule('20262027')).games;
  assert.deepEqual(
    games.map(({ gameState, homeScore }) => [gameState, homeScore]),
    [
      ['FINAL', 4],
      ['OFF', 1],
      ['FUT', null],
    ],
  );
  // Only game 1 (started, not official) is looked up, at any cached age.
  assert.deepEqual(readKeys.sort(), [
    'boxscore_1 ttl=Infinity',
    'landing_1 ttl=Infinity',
    'team_CGY_week_now ttl=Infinity',
    'team_EDM_week_now ttl=Infinity',
  ]);
});

test('pollGames refreshes every started, not yet official game in the window, queues the DB write and hands final games to player stats', async () => {
  const hoursAgo = (hours) =>
    new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const seasonGames = [
    makeWeeklyGame(1, 'FUT', hoursAgo(1)),
    makeWeeklyGame(2, 'OFF', hoursAgo(2)),
    makeWeeklyGame(3, 'FUT', UPCOMING),
    makeWeeklyGame(4, 'FINAL', hoursAgo(13)),
    makeWeeklyGame(5, 'LIVE', hoursAgo(3)),
    makeWeeklyGame(6, 'FINAL', hoursAgo(4)),
  ];
  const nhlBoxscores = {
    1: { id: 1, gameState: 'LIVE', homeTeam: { score: 1 }, awayTeam: { score: 0 }, periodDescriptor: { number: 2 } },
    6: { id: 6, season: 20262027, gameType: 2, gameState: 'FINAL', homeTeam: { id: 10, score: 2 }, awayTeam: { id: 6, score: 3 }, periodDescriptor: { periodType: 'SO' } },
  };
  const requestedPaths = [];
  const boxscoreTtls = [];
  const serviceTasks = [];
  const ingestedGames = [];
  const service = createScheduleService({
    nhlApi: {
      axiosNhl: {
        get: async (path) => {
          requestedPaths.push(path);
          const gameId = path.match(/\/gamecenter\/(\d+)\/boxscore/)[1];
          if (!nhlBoxscores[gameId]) throw new Error('NHL down');
          return { data: nhlBoxscores[gameId] };
        },
      },
    },
    cache: {
      CACHE_TYPES,
      getOrFetchCached: async (type, key, fetcher, options) => {
        if (key === '20262027') {
          return { gameWeek: [{ date: '2026-10-27', games: seasonGames }] };
        }
        boxscoreTtls.push(options.ttlMs);
        return fetcher();
      },
      readCache: async () => null,
      writeCache: async () => {},
    },
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: (label, task) => {
      serviceTasks.push(label);
      if (label === 'team stats after final games') task();
    },
    playerStatsService: {
      ingestFinalGames: async (games) => ingestedGames.push(...games),
    },
  });

  const originalError = console.error;
  console.error = () => {};
  let summary;
  try {
    summary = await service.pollGames();
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(summary, { polled: 3, live: 1, final: 1, failed: 1 });
  assert.deepEqual(requestedPaths.sort(), [
    '/gamecenter/1/boxscore',
    '/gamecenter/5/boxscore',
    '/gamecenter/6/boxscore',
  ]);
  assert.deepEqual(boxscoreTtls, [60000, 60000, 60000]);
  assert.deepEqual(serviceTasks, [
    'live game statuses',
    'team stats after final games',
  ]);
  assert.deepEqual(ingestedGames, [
    { gameId: 6, seasonId: '20262027', gameType: 2, teamIds: [10, 6] },
  ]);
});

test('refreshScheduleCache sweeps the official games of the fresh schedule', async () => {
  const sweptGames = [];
  const rawGame = (id, gameState, gameType = 2) => ({
    id,
    season: 20262027,
    gameType,
    gameState,
    startTimeUTC: '2026-10-27T23:00:00Z',
    homeTeam: { id: 10 },
    awayTeam: { id: 6 },
  });
  const service = createScheduleService({
    nhlApi: {
      axiosNhl: {
        get: async (path) => ({
          data: path === '/schedule/2026-09-01'
            ? { gameWeek: [{ games: [rawGame(1, 'OFF'), rawGame(2, 'FUT')] }] }
            : {},
        }),
      },
    },
    cache: { CACHE_TYPES, writeCache: async () => {} },
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: () => {},
    playerStatsService: {
      sweepTeamStats: async (games) => {
        sweptGames.push(...games);
        return {};
      },
    },
  });

  const originalLog = console.log;
  console.log = () => {};
  try {
    await service.refreshScheduleCache();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(sweptGames, [
    {
      gameId: 1,
      seasonId: '20262027',
      gameType: 2,
      teamIds: [10, 6],
    },
  ]);
});
