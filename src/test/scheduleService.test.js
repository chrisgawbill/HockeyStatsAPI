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
