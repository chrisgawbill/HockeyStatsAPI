const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPlayerStatsService,
} = require('#slices/players/playerStatsService.js');
const { fetchAllStatsRows } = require('#platform/nhlStatsPages.js');

const CACHE_TYPES = { PLAYER: 'player' };

/** Builds `count` skater rows with ids starting at `firstId`. */
function skaterRows(count, firstId = 1) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: firstId + index,
    skaterFullName: `Skater ${firstId + index}`,
  }));
}

/** A stats client serving `rows` in pages, read from the URL's start/limit. */
function pagedStatsClient(rows, requestedUrls) {
  return {
    async get(url) {
      requestedUrls.push(url);
      const query = new URLSearchParams(url.split('?')[1]);
      const start = Number(query.get('start'));
      const limit = Number(query.get('limit'));
      return {
        data: { data: rows.slice(start, start + limit), total: rows.length },
      };
    },
  };
}

/** A cache stub that stores fetched values in memory under `type:key`. */
function memoryCache() {
  const entries = new Map();
  return {
    entries,
    CACHE_TYPES,
    async getOrFetchCached(type, key, fetcher) {
      const cacheId = `${type}:${key}`;
      if (!entries.has(cacheId)) entries.set(cacheId, await fetcher());
      return entries.get(cacheId);
    },
  };
}

function makeService(rows) {
  const requestedUrls = [];
  const persistLabels = [];
  const cache = memoryCache();
  const service = createPlayerStatsService({
    nhlApi: {
      axiosNhlStats: pagedStatsClient(rows, requestedUrls),
      axiosNhlGoalie: pagedStatsClient(rows, requestedUrls),
    },
    cache,
    runServiceTask: (label) => persistLabels.push(label),
  });
  return { service, requestedUrls, persistLabels, cache };
}

test('fetchAllStatsRows stops at a short page or at the reported total', async () => {
  const starts = [];
  const allRows = skaterRows(250);
  const { data } = await fetchAllStatsRows(async (start, limit) => {
    starts.push(start);
    return { data: allRows.slice(start, start + limit), total: allRows.length };
  });
  assert.equal(data.length, 250);
  assert.deepEqual(starts, [0, 100, 200]);

  const exactStarts = [];
  const exactRows = skaterRows(200);
  await fetchAllStatsRows(async (start, limit) => {
    exactStarts.push(start);
    return { data: exactRows.slice(start, start + limit), total: 200 };
  });
  assert.deepEqual(exactStarts, [0, 100]);

  await assert.rejects(
    fetchAllStatsRows(async () => ({ total: 0 })),
    /no data array/,
  );
});

test('the league-wide skater summary returns every skater, sorted and paged', async () => {
  const { service, requestedUrls, cache } = makeService(skaterRows(230));

  const skaters = await service.getSkaterSummary(undefined, '20252026');

  assert.equal(skaters.length, 230);
  assert.equal(skaters[229].playerId, 230);
  assert.equal(requestedUrls.length, 3);
  for (const url of requestedUrls) {
    assert.match(url, /^\/summary\?cayenneExp=/);
    assert.match(url, /&sort=/);
    assert.ok(decodeURIComponent(url).includes('"property":"playerId"'));
  }
  assert.ok(cache.entries.has('player:skater_summary_league_20252026'));
});

/**
 * A withTransaction stub over in-memory tables: stored team reports keyed
 * `season:team:report`, and the ingested games ledger keyed by game id, with
 * a settable clock (`db.nowMs`) for the retry cool-down.
 */
function memoryDb({ failReads = false } = {}) {
  const db = { reports: new Map(), ingestedGames: new Map(), nowMs: 0 };
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT payload')) {
        if (failReads) throw new Error('db down');
        const payload = db.reports.get(params.slice(0, 3).join(':'));
        return { rows: payload ? [{ payload }] : [] };
      }
      if (sql.includes('SELECT team_id, payload')) {
        const [seasonId, report] = params;
        const rows = [...db.reports]
          .map(([key, payload]) => [key.split(':'), payload])
          .filter(([key]) => key[0] === seasonId && key[2] === report)
          .map(([key, payload]) => ({ team_id: Number(key[1]), payload }));
        return { rows };
      }
      if (sql.includes('INSERT INTO team_player_stat_reports')) {
        db.reports.set(params.slice(0, 3).join(':'), JSON.parse(params[3]));
        return { rowCount: 1 };
      }
      if (sql.includes('INSERT INTO team_stats_ingested_games')) {
        const [gameIds, retryAfterSeconds] = params;
        const claimed = gameIds.filter((gameId) => {
          const ledgerRow = db.ingestedGames.get(gameId);
          return (
            !ledgerRow ||
            (!ledgerRow.caughtUp &&
              ledgerRow.claimedAtMs < db.nowMs - retryAfterSeconds * 1000)
          );
        });
        for (const gameId of claimed) {
          db.ingestedGames.set(gameId, { caughtUp: false, claimedAtMs: db.nowMs });
        }
        return { rows: claimed.map((gameId) => ({ game_id: String(gameId) })) };
      }
      if (sql.includes('SET caught_up = true')) {
        for (const gameId of params[0]) db.ingestedGames.get(gameId).caughtUp = true;
        return { rowCount: params[0].length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  db.withTransaction = (callback) => callback(client);
  return db;
}

/** A service on `db` whose stats clients answer every URL with `rows`, awaiting queued tasks inline. */
function makeDbService(db, rows, { failNhl = false } = {}) {
  const requestedUrls = [];
  const statsClient = {
    async get(url) {
      requestedUrls.push(url);
      if (failNhl) throw new Error('NHL down');
      return { data: { data: rows(), total: rows().length } };
    },
  };
  const tasks = [];
  const service = createPlayerStatsService({
    nhlApi: { axiosNhlStats: statsClient, axiosNhlGoalie: statsClient },
    cache: memoryCache(),
    runServiceTask: (label, task) => {
      if (label.startsWith('store ')) tasks.push(task());
    },
    withTransaction: db.withTransaction,
  });
  return { service, requestedUrls, tasks };
}

test('team reports are read from the database; a missing one is fetched once and stored', async () => {
  const db = memoryDb();
  const { service, requestedUrls, tasks } = makeDbService(db, () =>
    skaterRows(2),
  );

  await service.getSkaterCorsi('10', '20252026');
  await Promise.all(tasks);
  assert.equal(requestedUrls.length, 1);
  assert.ok(db.reports.has('20252026:10:skater_corsi'));

  const corsi = await service.getSkaterCorsi('10', '20252026');
  assert.equal(requestedUrls.length, 1);
  assert.equal(corsi.data.length, 2);
});

test('an unreadable database falls back to the NHL without storing', async () => {
  const db = memoryDb({ failReads: true });
  const { service, requestedUrls, tasks } = makeDbService(db, () =>
    skaterRows(1),
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    const goalies = await service.getGoalieSummary('10', '20252026');
    assert.equal(goalies.length, 1);
  } finally {
    console.error = originalError;
  }
  assert.equal(requestedUrls.length, 1);
  assert.equal(tasks.length, 0);
});

/** A stored goalie summary counting `starts` games. */
const goalieReport = (starts) => ({ data: [{ goalieId: 30, gamesStarted: starts }] });

test('an official game refreshes both teams once and retries, after a cool-down, while the NHL is behind', async () => {
  const db = memoryDb();
  db.reports.set('20252026:10:goalie_summary', goalieReport(5));
  db.reports.set('20252026:6:goalie_summary', goalieReport(5));
  let nhlStarts = 5;
  const rows = () => [{ playerId: 7, goalieId: 30, gamesStarted: nhlStarts }];
  const game = { gameId: 99, seasonId: '20252026', gameType: 2, teamIds: [10, 6] };
  const preseasonGame = { ...game, gameId: 98, gameType: 1 };
  const { service, requestedUrls } = makeDbService(db, rows);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await service.ingestOfficialGames([game, preseasonGame]), {
      ingested: 0,
      retrying: 1,
    });
    assert.equal(requestedUrls.length, 8);

    db.nowMs = 5 * 60 * 1000;
    assert.deepEqual(await service.ingestOfficialGames([game]), {
      ingested: 0,
      retrying: 0,
    });
    assert.equal(requestedUrls.length, 8);
  } finally {
    console.warn = originalWarn;
  }

  nhlStarts = 6;
  db.nowMs = 11 * 60 * 1000;
  assert.deepEqual(await service.ingestOfficialGames([game]), {
    ingested: 1,
    retrying: 0,
  });
  assert.equal(requestedUrls.length, 16);
  assert.equal(db.reports.size, 8);
  assert.equal(db.ingestedGames.has(98), false);

  db.nowMs = 60 * 60 * 1000;
  assert.deepEqual(await service.ingestOfficialGames([game]), {
    ingested: 0,
    retrying: 0,
  });
  assert.equal(requestedUrls.length, 16);
});

test('a failed refresh leaves the game to retry', async () => {
  const db = memoryDb();
  const game = { gameId: 99, seasonId: '20252026', gameType: 2, teamIds: [10] };
  const { service } = makeDbService(db, () => [], { failNhl: true });

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await service.ingestOfficialGames([game]), {
      ingested: 0,
      retrying: 1,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(db.ingestedGames.get(99).caughtUp, false);
});

test('the sweep refreshes only teams with fewer stored goalie starts than official games', async () => {
  const db = memoryDb();
  const officialGame = (gameId, teamIds, gameType = 2) => ({
    gameId,
    seasonId: '20252026',
    gameType,
    teamIds,
  });
  db.reports.set('20252026:10:goalie_summary', goalieReport(2));
  db.reports.set('20252026:6:goalie_summary', goalieReport(1));
  db.reports.set('20252026:8:goalie_summary', goalieReport(1));

  const rows = () => [{ playerId: 7, goalieId: 30, gamesStarted: 1 }];
  const { service, requestedUrls } = makeDbService(db, rows);
  const summary = await service.sweepTeamStats([
    officialGame(1, [10, 6]),
    officialGame(2, [10, 22]),
    officialGame(3, [8, 6]),
    officialGame(4, [8, 22], 1),
  ]);

  // 10 is caught up (2 of 2) and 8 too (preseason games do not count); 6
  // stored 1 of 2 and 22 has nothing stored. 6 is still behind afterwards.
  assert.deepEqual(summary, {
    teamsChecked: 4,
    teamsRefreshed: 2,
    teamsBehind: 1,
    teamsFailed: 0,
  });
  assert.equal(requestedUrls.length, 8);
  assert.ok(db.reports.has('20252026:22:skater_summary'));
  assert.ok(!db.reports.has('20252026:10:skater_summary'));
});
