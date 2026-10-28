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
 * `season:team:report`, and the set of ingested game ids.
 */
function memoryDb({ failReads = false } = {}) {
  const reports = new Map();
  const ingestedGames = new Set();
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT payload')) {
        if (failReads) throw new Error('db down');
        const payload = reports.get(params.slice(0, 3).join(':'));
        return { rows: payload ? [{ payload }] : [] };
      }
      if (sql.includes('INSERT INTO team_player_stat_reports')) {
        reports.set(params.slice(0, 3).join(':'), JSON.parse(params[3]));
        return { rowCount: 1 };
      }
      if (sql.includes('INSERT INTO team_stats_ingested_games')) {
        const claimed = params[0].filter((gameId) => !ingestedGames.has(gameId));
        claimed.forEach((gameId) => ingestedGames.add(gameId));
        return { rows: claimed.map((gameId) => ({ game_id: String(gameId) })) };
      }
      if (sql.includes('DELETE FROM team_stats_ingested_games')) {
        params[0].forEach((gameId) => ingestedGames.delete(gameId));
        return { rowCount: params[0].length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    reports,
    ingestedGames,
    withTransaction: (callback) => callback(client),
  };
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

test('an official regular-season game refreshes both teams once; a failed refresh is retried', async () => {
  const db = memoryDb();
  let goals = 1;
  const rows = () => [{ playerId: 7, skaterFullName: 'Skater 7', goals }];
  db.reports.set('20252026:10:skater_summary', { data: rows() });
  const game = { gameId: 99, seasonId: '20252026', gameType: 2, teamIds: [10, 6] };

  const failing = makeDbService(db, rows, { failNhl: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await failing.service.ingestOfficialGames([game]), {
      ingested: 0,
      failed: 1,
      teamsRefreshed: 0,
      teamsFailed: 2,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(db.ingestedGames.has(99), false);

  goals = 2;
  const { service, requestedUrls } = makeDbService(db, rows);
  const preseasonGame = { ...game, gameId: 98, gameType: 1 };
  assert.deepEqual(await service.ingestOfficialGames([game, preseasonGame]), {
    ingested: 1,
    failed: 0,
    teamsRefreshed: 2,
    teamsFailed: 0,
  });
  assert.equal(requestedUrls.length, 8);
  assert.equal(db.reports.size, 8);
  const [skater] = await service.getSkaterSummary('10', '20252026');
  assert.equal(skater.goals, 2);

  assert.deepEqual(await service.ingestOfficialGames([game]), {
    ingested: 0,
    failed: 0,
    teamsRefreshed: 0,
    teamsFailed: 0,
  });
  assert.equal(requestedUrls.length, 8);
});

test('the sweep ingests missed games, refreshes each team once, and re-refreshes recent games', async () => {
  const db = memoryDb();
  const now = Date.parse('2026-10-28T12:00:00Z');
  const officialGame = (gameId, teamIds, hoursAgo) => ({
    gameId,
    seasonId: '20252026',
    gameType: 2,
    teamIds,
    startTimeUTC: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
  });
  const oldIngested = officialGame(1, [10, 6], 72);
  const oldMissed = officialGame(2, [10, 8], 48);
  const recentIngested = officialGame(3, [22, 20], 3);
  const oldDone = officialGame(4, [1, 2], 96);
  [1, 3, 4].forEach((gameId) => db.ingestedGames.add(gameId));

  const { service, requestedUrls } = makeDbService(db, () => skaterRows(1));
  const summary = await service.sweepTeamStats(
    [oldIngested, oldMissed, recentIngested, oldDone],
    now,
  );

  assert.deepEqual(summary, {
    ingested: 1,
    failed: 0,
    teamsRefreshed: 4,
    teamsFailed: 0,
  });
  assert.equal(requestedUrls.length, 16);
  for (const teamId of [10, 8, 22, 20]) {
    assert.ok(db.reports.has(`20252026:${teamId}:goalie_summary`));
  }
  assert.ok(!db.reports.has('20252026:6:goalie_summary'));
  assert.ok(db.ingestedGames.has(2));
});

test('summary rows are persisted on a fresh fetch, not on cache hits', async () => {
  const { service, persistLabels } = makeService(skaterRows(3));

  await service.getSkaterSummary(undefined, '20252026');
  await service.getSkaterSummary(undefined, '20252026');

  assert.deepEqual(persistLabels, ['skater summary all 20252026']);
});
