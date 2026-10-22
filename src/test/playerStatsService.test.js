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

test('team summaries keep their cache key and fetch a single page', async () => {
  const { service, requestedUrls, cache } = makeService(skaterRows(35));

  await service.getGoalieSummary('10', '20252026');

  assert.equal(requestedUrls.length, 1);
  assert.ok(decodeURIComponent(requestedUrls[0]).includes('teamId=10'));
  assert.ok(cache.entries.has('player:goalie_summary_10_20252026'));
});

test('summary rows are persisted on a fresh fetch, not on cache hits', async () => {
  const { service, persistLabels } = makeService(skaterRows(3));

  await service.getSkaterSummary(undefined, '20252026');
  await service.getSkaterSummary(undefined, '20252026');

  assert.deepEqual(persistLabels, ['skater summary all 20252026']);
});
