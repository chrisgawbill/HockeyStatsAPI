const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseStatviewBody } = require('#platform/ahlApiClient.js');
const {
  mapAhlSeasons,
  mapAhlTeams,
  mapAhlScheduleGames,
  mapAhlRoster,
} = require('#slices/ahl/mappers/ahlMapper.js');
const { createAhlService, AHL_REPORTS } = require('#slices/ahl/ahlService.js');

// Real HockeyTech payloads recorded 2026-10-29, trimmed and with the key removed.
const FIXTURE_DIR = path.join(__dirname, 'fixtures/ahl');
const readFixtureText = (fileName) =>
  fs.readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8');
const readSiteKit = (fileName) => JSON.parse(readFixtureText(fileName)).SiteKit;

const CACHE_TYPES = {
  SCHEDULE: 'schedule',
  TEAM: 'team',
  ROSTER: 'roster',
  STANDINGS: 'standings',
  STAT_LEADERS: 'stat-leaders',
};

/** Feed stub that serves the fixtures, or throws for every call when `isDown`. */
function makeFeedStub({ isDown = false } = {}) {
  const fixtureByView = {
    seasons: 'seasons.json',
    teamsbyseason: 'teamsbyseason.json',
    schedule: 'schedule.json',
    roster: 'roster.json',
    statviewtype: 'standings.json',
  };
  return {
    isAhlFeedConfigured: () => true,
    fetchModulekit: async (view) => {
      if (isDown) throw new Error('feed down');
      return readSiteKit(fixtureByView[view]);
    },
    fetchStatview: async (view, params) => {
      if (isDown) throw new Error('feed down');
      return parseStatviewBody(readFixtureText(`${params.position}.jsonp`))[0];
    },
  };
}

/** In-memory cache stub: serves any stored entry and records every write. */
function makeCacheStub(cachedEntries = new Map()) {
  return {
    CACHE_TYPES,
    cachedEntries,
    getOrFetchCached: async (type, key, fetcher) => {
      const cacheId = `${type}:${key}`;
      if (cachedEntries.has(cacheId)) return cachedEntries.get(cacheId);
      return fetcher();
    },
    writeCache: async (type, key, value) => {
      cachedEntries.set(`${type}:${key}`, value);
    },
  };
}

/** Transaction stub whose client records each SQL statement and its params. */
function makeTransactionStub({ storedReport = null } = {}) {
  const queries = [];
  return {
    queries,
    withTransaction: (callback) =>
      callback({
        query: async (sql, params) => {
          queries.push({ sql: String(sql), params });
          return { rows: storedReport ? [{ payload: storedReport }] : [] };
        },
      }),
  };
}

/** Builds the service; `whenTasksDone()` waits for its background store tasks. */
function makeService({ ahlApi, cache, transaction }) {
  const pendingTasks = [];
  const ahlService = createAhlService({
    ahlApi,
    cache,
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: (label, serviceFn) => {
      pendingTasks.push(serviceFn());
      return null;
    },
    withTransaction: transaction.withTransaction,
  });
  ahlService.whenTasksDone = () => Promise.all(pendingTasks);
  return ahlService;
}

test('mapAhlSeasons maps HockeyTech seasons to our season id and game type', () => {
  const seasonsById = new Map(
    mapAhlSeasons(readSiteKit('seasons.json')).map((season) => [
      season.hockeytechSeasonId,
      season,
    ]),
  );
  assert.deepEqual(
    [94, 92, 90].map((id) => [
      seasonsById.get(id).seasonId,
      seasonsById.get(id).gameType,
    ]),
    [
      ['20262027', 2],
      ['20252026', 3],
      ['20252026', 2],
    ],
  );
  // The all-star event has no game type and is left out.
  assert.equal(seasonsById.has(91), false);
  const gameTypesByName = Object.fromEntries(
    [...seasonsById.values()].map((season) => [
      season.seasonName,
      season.gameType,
    ]),
  );
  assert.equal(gameTypesByName['2017-18 Exhibition'], 1);
  assert.equal(gameTypesByName['2021 Pacific Division Playoffs'], 3);
});

test('mapAhlScheduleGames keeps scores null until a game starts', () => {
  const season = { hockeytechSeasonId: 94, seasonId: '20262027', gameType: 2 };
  const [finalGame, liveGame, futureGame] = mapAhlScheduleGames(
    readSiteKit('schedule.json'),
    season,
  );
  assert.equal(finalGame.statusCode, 4);
  assert.equal(typeof finalGame.homeScore, 'number');
  assert.equal(liveGame.statusCode, 2);
  assert.equal(typeof liveGame.awayScore, 'number');
  assert.equal(futureGame.statusCode, 1);
  assert.equal(futureGame.homeScore, null);
  assert.equal(futureGame.awayScore, null);
  assert.match(finalGame.startTimeUtc, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(finalGame.seasonId, '20262027');
  assert.ok(finalGame.homeTeamCode && finalGame.awayTeamCode);
});

test('mapAhlRoster keeps players and drops team staff', () => {
  const { players, rosterEntries } = mapAhlRoster(
    readSiteKit('roster.json'),
    94,
    319,
  );
  assert.equal(players.length, 3);
  assert.equal(rosterEntries.length, 3);
  assert.ok(players.every((player) => Number.isInteger(player.playerId)));
  assert.deepEqual(
    { ...rosterEntries[0], sourcePayload: undefined },
    {
      hockeytechSeasonId: 94,
      teamId: 319,
      playerId: players[0].playerId,
      sweaterNumber: rosterEntries[0].sweaterNumber,
      positionCode: players[0].positionCode,
      sourcePayload: undefined,
    },
  );
});

test('mapAhlTeams and parseStatviewBody read the recorded payloads', () => {
  const [firstTeam] = mapAhlTeams(readSiteKit('teamsbyseason.json'));
  assert.equal(firstTeam.teamCode, 'ABB');
  assert.equal(firstTeam.teamId, 440);
  const skaters = parseStatviewBody(readFixtureText('skaters.jsonp'));
  assert.ok(skaters[0].sections[0].data[0].row.player_id);
});

test('refreshCurrentSeason caches under ahl: keys and stores the current season', async () => {
  const cache = makeCacheStub();
  const transaction = makeTransactionStub();
  // Only season 94 (2026-27 regular season) is current and started.
  const ahlService = makeService({
    ahlApi: makeFeedStub(),
    cache,
    transaction,
  });
  await ahlService.refreshCurrentSeason();
  await ahlService.whenTasksDone();

  const cachedKeys = [...cache.cachedEntries.keys()].map((cacheId) =>
    cacheId.slice(cacheId.indexOf(':') + 1),
  );
  assert.ok(
    cachedKeys.every((key) => key.startsWith('ahl:')),
    cachedKeys.join(),
  );
  assert.equal(cachedKeys.length, 6);

  const tablesWritten = transaction.queries.map(
    (query) => query.sql.match(/INSERT INTO (\w+)/)?.[1],
  );
  assert.deepEqual(tablesWritten, [
    'ahl_seasons',
    'ahl_teams',
    'ahl_schedule_games',
    'ahl_team_stat_reports',
    'ahl_team_stat_reports',
    'ahl_team_stat_reports',
  ]);
  const storedReports = transaction.queries
    .filter((query) => query.sql.includes('ahl_team_stat_reports'))
    .map((query) => query.params.slice(0, 3));
  assert.deepEqual(storedReports, [
    [94, 0, AHL_REPORTS.STANDINGS],
    [94, 0, AHL_REPORTS.SKATERS],
    [94, 0, AHL_REPORTS.GOALIES],
  ]);
});

test('with the feed down, refresh does not throw and cached and stored data are still read', async () => {
  const cache = makeCacheStub();
  await makeService({
    ahlApi: makeFeedStub(),
    cache,
    transaction: makeTransactionStub(),
  }).refreshCurrentSeason();

  const storedStandings = { stored: true };
  const offlineService = makeService({
    ahlApi: makeFeedStub({ isDown: true }),
    cache,
    transaction: makeTransactionStub({ storedReport: storedStandings }),
  });
  await offlineService.refreshCurrentSeason();
  assert.equal((await offlineService.getSchedule(94)).Schedule.length, 3);
  assert.equal(await offlineService.findHockeytechSeasonId('20252026', 3), 92);
  assert.equal(
    await offlineService.getLeagueReport(94, AHL_REPORTS.STANDINGS),
    storedStandings,
  );
});

test('refreshCurrentSeason is skipped without a feed key', async () => {
  const transaction = makeTransactionStub();
  await makeService({
    ahlApi: { ...makeFeedStub(), isAhlFeedConfigured: () => false },
    cache: makeCacheStub(),
    transaction,
  }).refreshCurrentSeason();
  assert.equal(transaction.queries.length, 0);
});
