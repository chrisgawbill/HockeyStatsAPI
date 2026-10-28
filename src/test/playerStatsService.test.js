const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPlayerStatsService,
} = require('#slices/players/playerStatsService.js');
const { fetchAllStatsRows } = require('#platform/nhlStatsPages.js');

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

/**
 * A withTransaction stub over in-memory tables: stored team reports keyed
 * `season:team:report` (league-wide under team 0) with when each was stored,
 * and the ingested games ledger keyed by game id, with a settable clock
 * (`db.nowMs`) for the retry cool-down and report staleness.
 */
function memoryDb({ failReads = false } = {}) {
  const db = {
    reports: new Map(),
    updatedAtMs: new Map(),
    ingestedGames: new Map(),
    nowMs: 0,
  };
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT payload')) {
        if (failReads) throw new Error('db down');
        const payload = db.reports.get(params.slice(0, 3).join(':'));
        return { rows: payload ? [{ payload }] : [] };
      }
      if (sql.includes('SELECT team_id, payload')) {
        const [seasonId, report] = params;
        const rows = [...db.reports.keys()]
          .filter((key) => key === `${seasonId}:${key.split(':')[1]}:${report}`)
          .map((key) => ({
            team_id: Number(key.split(':')[1]),
            payload: db.reports.get(key),
            updated_at: new Date(db.updatedAtMs.get(key) ?? 0),
          }));
        return { rows };
      }
      if (sql.includes('SELECT report')) {
        const prefix = `${params[0]}:${params[1]}:`;
        const rows = [...db.reports.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ report: key.slice(prefix.length) }));
        return { rows };
      }
      if (sql.includes('INSERT INTO team_stat_reports')) {
        const key = params.slice(0, 3).join(':');
        db.reports.set(key, JSON.parse(params[3]));
        db.updatedAtMs.set(key, db.nowMs);
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

/**
 * A service on `db` whose stats clients answer each URL with `rows(url)` and
 * whose api-web client answers with `leaders(url)`, running queued store
 * tasks inline (collected in `tasks`) and reading the clock from `db.nowMs`.
 */
function makeDbService(
  db,
  rows,
  { failNhl = false, leaders = () => ({}), statsClient } = {},
) {
  const requestedUrls = [];
  const client = (answer) => ({
    async get(url) {
      requestedUrls.push(url);
      if (failNhl) throw new Error('NHL down');
      return { data: answer(url) };
    },
  });
  const rowsClient =
    statsClient ??
    client((url) => ({ data: rows(url), total: rows(url).length }));
  const tasks = [];
  const service = createPlayerStatsService({
    nhlApi: {
      axiosNhlStats: rowsClient,
      axiosNhlGoalie: rowsClient,
      axiosNhlTeam: rowsClient,
      axiosNhl: client(leaders),
    },
    runServiceTask: (label, task) => {
      if (label.startsWith('store ')) tasks.push(task());
    },
    withTransaction: db.withTransaction,
    now: () => db.nowMs,
  });
  return { service, requestedUrls, tasks };
}

test('the league-wide skater summary is every skater, sorted, paged and stored', async () => {
  const db = memoryDb();
  const requestedUrls = [];
  const { service, tasks } = makeDbService(db, null, {
    statsClient: pagedStatsClient(skaterRows(230), requestedUrls),
  });

  const skaters = await service.getSkaterSummary(undefined, '20252026');
  await Promise.all(tasks);

  assert.equal(skaters.length, 230);
  assert.equal(skaters[229].playerId, 230);
  assert.equal(requestedUrls.length, 3);
  for (const url of requestedUrls) {
    assert.match(url, /^\/summary\?cayenneExp=/);
    assert.ok(!decodeURIComponent(url).includes('teamId'));
    assert.ok(decodeURIComponent(url).includes('"property":"playerId"'));
  }
  assert.equal(db.reports.get('20252026:0:skater_summary').data.length, 230);

  await service.getSkaterSummary(undefined, '20252026');
  assert.equal(requestedUrls.length, 3);
});

test('league-wide Corsi is paged so every skater is stored', async () => {
  const db = memoryDb();
  const requestedUrls = [];
  const { service, tasks } = makeDbService(db, null, {
    statsClient: pagedStatsClient(skaterRows(150), requestedUrls),
  });

  const corsi = await service.getSkaterCorsi(undefined, '20252026');
  await Promise.all(tasks);
  assert.equal(corsi.data.length, 150);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /^\/percentages\?/);
  assert.ok(db.reports.has('20252026:0:skater_corsi'));
});

test('stat leaders are stored per category; an empty category is not stored', async () => {
  const db = memoryDb();
  const { service, requestedUrls, tasks } = makeDbService(db, () => [], {
    leaders: (url) =>
      url.includes('categories=goals') ? { goals: [{ id: 7, value: 9 }] } : {},
  });

  const goals = await service.getLeaders('skater', 'goals', '20252026');
  const shutouts = await service.getLeaders('goalie', 'shutouts', '20252026');
  await Promise.all(tasks);
  assert.equal(goals.goals[0].value, 9);
  assert.deepEqual(shutouts, {});
  assert.match(requestedUrls[0], /^\/skater-stats-leaders\/20252026\/2\?/);
  assert.ok(db.reports.has('20252026:0:skater_leaders:goals'));
  assert.ok(!db.reports.has('20252026:0:goalie_leaders:shutouts'));

  await service.getLeaders('skater', 'goals', '20252026');
  assert.equal(requestedUrls.length, 2);
});

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

test('the team summary is read from the database, keeping the raw NHL shape', async () => {
  const db = memoryDb();
  const { service, requestedUrls, tasks } = makeDbService(db, () => [
    { teamId: 10, wins: 7 },
  ]);

  const fetched = await service.getTeamSummary('10', '20252026');
  await Promise.all(tasks);
  assert.equal(requestedUrls.length, 1);
  assert.ok(
    decodeURIComponent(requestedUrls[0]).includes(
      'seasonId=20252026 and gameTypeId=2 and teamId=10',
    ),
  );
  assert.equal(fetched.data[0].wins, 7);

  const stored = await service.getTeamSummary('10', '20252026');
  assert.equal(requestedUrls.length, 1);
  assert.deepEqual(stored, fetched);
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
  db.reports.set('20252026:0:skater_leaders:goals', { goals: [] });
  let nhlStarts = 5;
  // A team's goalie summary counts its starts; the league's counts both teams'.
  const rows = (url) => [
    {
      playerId: 7,
      goalieId: 30,
      gamesStarted: url.includes('teamId') ? nhlStarts : 2 * nhlStarts,
    },
  ];
  const game = { gameId: 99, seasonId: '20252026', gameType: 2, teamIds: [10, 6] };
  const preseasonGame = { ...game, gameId: 98, gameType: 1 };
  const { service, requestedUrls } = makeDbService(db, rows, {
    leaders: () => ({ goals: [{ id: 7, value: nhlStarts }] }),
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await service.ingestOfficialGames([game, preseasonGame]), {
      ingested: 0,
      retrying: 1,
    });
    assert.equal(requestedUrls.length, 16);

    db.nowMs = 5 * 60 * 1000;
    assert.deepEqual(await service.ingestOfficialGames([game]), {
      ingested: 0,
      retrying: 0,
    });
    assert.equal(requestedUrls.length, 16);
  } finally {
    console.warn = originalWarn;
  }

  nhlStarts = 6;
  db.nowMs = 11 * 60 * 1000;
  assert.deepEqual(await service.ingestOfficialGames([game]), {
    ingested: 1,
    retrying: 0,
  });
  assert.equal(requestedUrls.length, 32);
  assert.equal(db.reports.size, 16);
  assert.equal(
    db.reports.get('20252026:0:skater_leaders:goals').goals[0].value,
    6,
  );
  assert.equal(db.ingestedGames.has(98), false);

  db.nowMs = 60 * 60 * 1000;
  assert.deepEqual(await service.ingestOfficialGames([game]), {
    ingested: 0,
    retrying: 0,
  });
  assert.equal(requestedUrls.length, 32);
});

test('a game is retried while the league-wide reports are behind', async () => {
  const db = memoryDb();
  db.reports.set('20252026:10:goalie_summary', goalieReport(5));
  db.reports.set('20252026:6:goalie_summary', goalieReport(5));
  db.reports.set('20252026:0:goalie_summary', goalieReport(10));
  // Both teams caught up (6 starts) but the league still counts 10.
  const rows = (url) => [
    { goalieId: 30, gamesStarted: url.includes('teamId') ? 6 : 10 },
  ];
  const game = { gameId: 99, seasonId: '20252026', gameType: 2, teamIds: [10, 6] };
  const { service } = makeDbService(db, rows);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await service.ingestOfficialGames([game]), {
      ingested: 0,
      retrying: 1,
    });
  } finally {
    console.warn = originalWarn;
  }
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

test('the sweep refreshes scopes behind their official games or not refreshed in a week', async () => {
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
  // stored 1 of 2, and 22 and the league have nothing stored. 6 and the
  // league (1 of 6 starts) are still behind afterwards.
  assert.deepEqual(summary, {
    teamsChecked: 5,
    teamsRefreshed: 3,
    teamsStale: 0,
    teamsBehind: 2,
    teamsFailed: 0,
  });
  assert.equal(requestedUrls.length, 15);
  assert.ok(db.reports.has('20252026:22:skater_summary'));
  assert.ok(db.reports.has('20252026:22:team_summary'));
  assert.ok(db.reports.has('20252026:0:skater_summary'));
  assert.ok(!db.reports.has('20252026:10:skater_summary'));

  const games = [
    officialGame(1, [10, 6]),
    officialGame(2, [10, 22]),
    officialGame(3, [8, 6]),
  ];
  // A week later every stored scope is re-checked against the NHL...
  db.nowMs = 8 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await service.sweepTeamStats(games), {
    teamsChecked: 5,
    teamsRefreshed: 5,
    teamsStale: 5,
    teamsBehind: 3,
    teamsFailed: 0,
  });
  // ...and a day after that only the scopes still behind (10, 6, league) are.
  db.nowMs += 24 * 60 * 60 * 1000;
  const { teamsRefreshed, teamsStale } = await service.sweepTeamStats(games);
  assert.deepEqual({ teamsRefreshed, teamsStale }, {
    teamsRefreshed: 3,
    teamsStale: 0,
  });
});
