const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const cacheManagerPath = require.resolve('#platform/cacheManager.js');
const pgPath = require.resolve('pg');
const originalPgCache = require.cache[pgPath];
const originalEnv = {
  CACHE_DATABASE_URL: process.env.CACHE_DATABASE_URL,
  CACHE_STORAGE: process.env.CACHE_STORAGE,
};

function restorePg() {
  if (originalPgCache) {
    require.cache[pgPath] = originalPgCache;
  } else {
    delete require.cache[pgPath];
  }
}

function installPgMock(cacheUsageRows, tableBytes = 0) {
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: {
      Pool: class {
        on() {}
        async query(sql) {
          if (
            String(sql).includes('FROM app_cache') &&
            String(sql).includes('GROUP BY type')
          ) {
            return { rows: cacheUsageRows };
          }
          if (String(sql).includes('pg_total_relation_size')) {
            return { rows: [{ table_bytes: tableBytes }] };
          }
          return { rows: [] };
        }
      },
    },
  };
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  delete require.cache[cacheManagerPath];
  restorePg();
}

function loadCacheManager(env = {}, pgRows = null, tableBytes = 0) {
  delete require.cache[cacheManagerPath];
  restorePg();
  if (pgRows) {
    installPgMock(pgRows, tableBytes);
  }
  for (const key of Object.keys(originalEnv)) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  return require('#platform/cacheManager.js');
}

afterEach(restoreEnv);

test('cache storage mode follows CACHE_STORAGE, else whether a database URL is set', () => {
  const url = 'postgres://user:pass@localhost:5432/hockey';
  const cases = [
    [{}, 'filesystem'],
    [{ CACHE_DATABASE_URL: url }, 'postgres'],
    [{ CACHE_DATABASE_URL: url, CACHE_STORAGE: 'filesystem' }, 'filesystem'],
    [{ CACHE_DATABASE_URL: url, CACHE_STORAGE: 'hybrid' }, 'hybrid'],
    // Unknown modes are ignored.
    [{ CACHE_DATABASE_URL: url, CACHE_STORAGE: 'redis' }, 'postgres'],
  ];
  for (const [env, expected] of cases) {
    assert.equal(
      loadCacheManager(env).getCacheStorageMode(),
      expected,
      JSON.stringify(env),
    );
  }
});

test('cache usage reports postgres bytes as the primary cache when configured', async () => {
  const cacheManager = loadCacheManager(
    {
      CACHE_DATABASE_URL: 'postgres://user:pass@localhost:5432/hockey',
    },
    [
      { type: 'schedule', entries: 2, bytes: 500 },
      { type: 'team', entries: 1, bytes: 1000 },
    ],
    16384,
  );

  const usage = await cacheManager.getCacheUsage();

  assert.equal(usage.storageMode, 'postgres');
  assert.equal(usage.primaryStore, 'postgres');
  assert.deepEqual(usage.sections, { schedule: 500, team: 1000 });
  assert.deepEqual(usage.largestSection, { type: 'team', size: 1000 });
  assert.equal(usage.total, 1500);
  assert.equal(usage.external.reachable, true);
  assert.equal(usage.external.totalEntries, 3);
  assert.equal(usage.external.totalBytes, 1500);
  assert.equal(usage.external.tableBytes, 16384);
  assert.deepEqual(usage.external.sections, {
    schedule: { entries: 2, bytes: 500 },
    team: { entries: 1, bytes: 1000 },
  });
  assert.ok(usage.local);
});

const HOUR_MS = 60 * 60 * 1000;

/** Installs a pg mock backed by `cacheRows` (cache_key -> row) and loads the cache in Postgres mode. */
function loadPostgresCacheManager(cacheRows) {
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: {
      Pool: class {
        on() {}
        async query(sql, params = []) {
          if (String(sql).includes('SELECT timestamp_ms, data')) {
            const cacheRow = cacheRows.get(params[0]);
            return { rows: cacheRow ? [cacheRow] : [] };
          }
          if (String(sql).includes('INSERT INTO app_cache')) {
            cacheRows.set(params[0], {
              timestamp_ms: params[3],
              data: params[4],
            });
          }
          return { rows: [] };
        }
      },
    },
  };
  delete require.cache[cacheManagerPath];
  for (const key of Object.keys(originalEnv)) {
    delete process.env[key];
  }
  process.env.CACHE_DATABASE_URL = 'postgres://user:pass@localhost:5432/hockey';
  return require('#platform/cacheManager.js');
}

/** Waits until `isDone` holds, polling between event-loop turns. */
async function waitFor(isDone) {
  for (let attempt = 0; attempt < 50 && !isDone(); attempt++) {
    await new Promise(setImmediate);
  }
  assert.ok(isDone());
}

const failingFetch = async () => {
  throw new Error('NHL unavailable');
};

test('an expired entry on its default TTL is served at once and refreshed in the background', async () => {
  const cacheRows = new Map([
    [
      'standings:20262027',
      { timestamp_ms: Date.now() - 25 * HOUR_MS, data: { v: 'old' } },
    ],
  ]);
  const cache = loadPostgresCacheManager(cacheRows);
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const fetchNew = async () => {
    fetchCount++;
    await fetchGate;
    return { v: 'new' };
  };

  const [first, second] = await Promise.all([
    cache.getOrFetchCached('standings', '20262027', fetchNew),
    cache.getOrFetchCached('standings', '20262027', fetchNew),
  ]);

  assert.deepEqual(first, { v: 'old' });
  assert.deepEqual(second, { v: 'old' });
  releaseFetch();
  await waitFor(() => cacheRows.get('standings:20262027').data.v === 'new');
  assert.equal(fetchCount, 1);
  assert.deepEqual(
    await cache.getOrFetchCached('standings', '20262027', fetchNew),
    { v: 'new' },
  );
});

test('a failed background refresh keeps the expired entry', async () => {
  const cacheRows = new Map([
    [
      'team:summary_all_20262027',
      { timestamp_ms: Date.now() - 25 * HOUR_MS, data: { v: 'old' } },
    ],
  ]);
  const cache = loadPostgresCacheManager(cacheRows);
  let refreshAttempted = false;

  const served = await cache.getOrFetchCached(
    'team',
    'summary_all_20262027',
    async () => {
      refreshAttempted = true;
      throw new Error('NHL unavailable');
    },
  );

  assert.deepEqual(served, { v: 'old' });
  await waitFor(() => refreshAttempted);
  await new Promise(setImmediate);
  assert.deepEqual(cacheRows.get('team:summary_all_20262027').data, {
    v: 'old',
  });
});

test('an expired entry on a caller-set TTL waits for the refetch, falling back to it when the fetch fails', async () => {
  const cacheRows = new Map([
    [
      'schedule:game_1',
      { timestamp_ms: Date.now() - HOUR_MS, data: { v: 'old' } },
    ],
  ]);
  const cache = loadPostgresCacheManager(cacheRows);
  const liveTtl = { ttlMs: 5 * 60 * 1000 };

  assert.deepEqual(
    await cache.getOrFetchCached('schedule', 'game_1', failingFetch, liveTtl),
    { v: 'old' },
  );
  assert.deepEqual(
    await cache.getOrFetchCached(
      'schedule',
      'game_1',
      async () => ({ v: 'new' }),
      liveTtl,
    ),
    { v: 'new' },
  );
});

test('a cache miss still fails when the fetch fails', async () => {
  const cache = loadPostgresCacheManager(new Map());
  await assert.rejects(
    cache.getOrFetchCached('standings', '20262027', failingFetch),
    /NHL unavailable/,
  );
});

test('a completed season cached after it ended never expires; one cached mid-season does', async () => {
  const afterSeasonEnd = new Date(2025, 9, 1).getTime();
  const midSeason = new Date(2025, 1, 1).getTime();
  const cacheRows = new Map([
    [
      'player:skater_all_20242025',
      { timestamp_ms: afterSeasonEnd, data: { v: 'final' } },
    ],
    [
      'player:goalie_all_20242025',
      { timestamp_ms: midSeason, data: { v: 'midseason' } },
    ],
  ]);
  const cache = loadPostgresCacheManager(cacheRows);
  const pastSeason = { seasonId: '20242025' };

  assert.deepEqual(
    await cache.readCache('player', 'skater_all_20242025', pastSeason),
    { v: 'final' },
  );
  assert.equal(await cache.readCache('player', 'skater_all_20242025'), null);
  assert.equal(
    await cache.readCache('player', 'goalie_all_20242025', pastSeason),
    null,
  );
});
