const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { getSslConfig } = require('#platform/connectionConfig.js');

const inFlightFetches = new Map();
let cachePool = null;
let cacheTableReady = false;

// Fail fast instead of hanging when the cache DB is configured but
// unreachable or slow, so the health and cache-usage endpoints (and the
// diagnostics page) stay responsive.
const CACHE_DB_TIMEOUT_MS =
  Number(process.env.CACHE_DATABASE_TIMEOUT_MS) || 5000;

const CACHE_TYPES = {
  PLAYER: 'player',
  ROSTER: 'roster',
  AI: 'ai',
  SCHEDULE: 'schedule',
  STANDINGS: 'standings',
  STAT_LEADERS: 'stat-leaders',
  TEAM: 'team',
  SHIFTS: 'shifts',
};

const CACHE_ROOT = path.join(__dirname, '../cache/');
const CACHE_SEED_ROOT = path.join(__dirname, '../cache-seed/');

const CACHE_STORAGE_MODES = {
  FILESYSTEM: 'filesystem',
  POSTGRES: 'postgres',
  HYBRID: 'hybrid',
};
const VALID_CACHE_STORAGE_MODES = new Set(Object.values(CACHE_STORAGE_MODES));

const CACHE_DIRS = {
  [CACHE_TYPES.PLAYER]: path.join(CACHE_ROOT, 'player-cache/'),
  [CACHE_TYPES.ROSTER]: path.join(CACHE_ROOT, 'roster-cache/'),
  [CACHE_TYPES.AI]: path.join(CACHE_ROOT, 'ai-cache/'),
  [CACHE_TYPES.SCHEDULE]: path.join(CACHE_ROOT, 'schedule-cache/'),
  [CACHE_TYPES.STANDINGS]: path.join(CACHE_ROOT, 'standings-cache/'),
  [CACHE_TYPES.STAT_LEADERS]: path.join(CACHE_ROOT, 'stat-leaders-cache/'),
  [CACHE_TYPES.TEAM]: path.join(CACHE_ROOT, 'team-cache/'),
  [CACHE_TYPES.SHIFTS]: path.join(CACHE_ROOT, 'shifts-cache/'),
};

/** Cache lifetimes in ms. Official shift charts never change once the game is OFF, so they never expire. */
const CACHE_TTLS = {
  [CACHE_TYPES.PLAYER]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.ROSTER]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.AI]: 365 * 24 * 60 * 60 * 1000,
  [CACHE_TYPES.SCHEDULE]: 12 * 60 * 60 * 1000,
  [CACHE_TYPES.STANDINGS]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.STAT_LEADERS]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.TEAM]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.SHIFTS]: Infinity,
};

/** Returns the TTL for a cache type, letting `options.ttlMs` override it. */
function getTtl(type, options = {}) {
  return options.ttlMs ?? CACHE_TTLS[type];
}

/** Resolves the storage mode from CACHE_STORAGE, falling back on whether a cache DB is configured. */
function getCacheStorageMode() {
  const requestedMode = (process.env.CACHE_STORAGE ?? '').trim().toLowerCase();
  if (VALID_CACHE_STORAGE_MODES.has(requestedMode)) {
    return requestedMode;
  }
  return process.env.CACHE_DATABASE_URL
    ? CACHE_STORAGE_MODES.POSTGRES
    : CACHE_STORAGE_MODES.FILESYSTEM;
}

/** True when entries should be read from and written to the Postgres cache. */
function usesExternalCache() {
  const mode = getCacheStorageMode();
  return (
    Boolean(process.env.CACHE_DATABASE_URL) &&
    (mode === CACHE_STORAGE_MODES.POSTGRES ||
      mode === CACHE_STORAGE_MODES.HYBRID)
  );
}

/** True when entries should be read from and written to the cache directory. */
function usesLocalCache() {
  const mode = getCacheStorageMode();
  return (
    mode === CACHE_STORAGE_MODES.FILESYSTEM ||
    mode === CACHE_STORAGE_MODES.HYBRID
  );
}

/** True when the entry is younger than `ttlMs` (or never expires). */
function isFresh(cachedAtMs, ttlMs) {
  return ttlMs === Infinity || Date.now() - cachedAtMs < ttlMs;
}

/** Builds the unique cache key `type:key` used in Postgres and for in-flight tracking. */
function buildCacheId(type, key) {
  return `${type}:${key}`;
}

/**
 * Lazily creates the shared pool for the cache database, or returns null when
 * none is configured. The pool logs 'error' events because an unhandled one
 * from an idle client would crash the process.
 */
function getCachePool() {
  if (!process.env.CACHE_DATABASE_URL) return null;
  if (!cachePool) {
    cachePool = new Pool({
      connectionString: process.env.CACHE_DATABASE_URL,
      ssl: getSslConfig(),
      connectionTimeoutMillis: CACHE_DB_TIMEOUT_MS,
      statement_timeout: CACHE_DB_TIMEOUT_MS,
      query_timeout: CACHE_DB_TIMEOUT_MS,
    });
    cachePool.on('error', (error) => {
      console.error('Cache DB pool error:', error.message);
    });
  }
  return cachePool;
}

/** Closes the cache database pool, if one was created. */
async function closeCachePool() {
  if (!cachePool) {
    return;
  }
  await cachePool.end();
  cachePool = null;
}

/** Creates the app_cache table and indexes once per process; returns the pool, or null if no cache DB is configured. */
async function ensureExternalCacheTable() {
  const pool = getCachePool();
  if (!pool || cacheTableReady) return pool;
  await pool.query(`
		CREATE TABLE IF NOT EXISTS app_cache (
			cache_key text PRIMARY KEY,
			type text NOT NULL,
			logical_key text NOT NULL,
			timestamp_ms bigint NOT NULL,
			data jsonb NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now()
		)
	`);
  await pool.query(`
		ALTER TABLE app_cache
		ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()
	`);
  await pool.query(`
		ALTER TABLE app_cache
		ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
	`);
  await pool.query(`
		CREATE UNIQUE INDEX IF NOT EXISTS app_cache_type_logical_key_idx
		ON app_cache (type, logical_key)
	`);
  await pool.query(`
		CREATE INDEX IF NOT EXISTS app_cache_type_idx
		ON app_cache (type)
	`);
  await pool.query(`
		CREATE INDEX IF NOT EXISTS app_cache_updated_at_idx
		ON app_cache (updated_at)
	`);
  cacheTableReady = true;
  return pool;
}

/** Reads a fresh entry from the cache directory, or null when missing, stale or unreadable. */
async function readLocalCache(type, key, ttlMs) {
  const filePath = path.join(CACHE_DIRS[type], `${key}.json`);
  try {
    const entry = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    if (isFresh(entry.timestamp, ttlMs)) {
      return entry.data;
    }
  } catch {}
  return null;
}

/** Writes an entry, stamped with the current time, to the cache directory. */
async function writeLocalCache(type, key, value) {
  const filePath = path.join(CACHE_DIRS[type], `${key}.json`);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(
    filePath,
    JSON.stringify({ timestamp: Date.now(), data: value }),
  );
}

/** Reads a fresh entry from the Postgres cache, or null when missing, stale or unreachable. */
async function readExternalCache(type, key, ttlMs) {
  try {
    const pool = await ensureExternalCacheTable();
    if (!pool) return null;
    const { rows: cacheRows } = await pool.query(
      'SELECT timestamp_ms, data FROM app_cache WHERE cache_key = $1',
      [buildCacheId(type, key)],
    );
    const [cacheRow] = cacheRows;
    if (!cacheRow) return null;
    if (!isFresh(Number(cacheRow.timestamp_ms), ttlMs)) return null;
    return cacheRow.data;
  } catch (error) {
    console.error(`Failed to read external ${type} cache for ${key}:`, error);
    return null;
  }
}

/** Upserts an entry into the Postgres cache; failures are logged, never thrown. */
async function writeExternalCache(type, key, value) {
  try {
    const pool = await ensureExternalCacheTable();
    if (!pool) return;
    await pool.query(
      `
			INSERT INTO app_cache (cache_key, type, logical_key, timestamp_ms, data, updated_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (cache_key)
			DO UPDATE SET
				timestamp_ms = EXCLUDED.timestamp_ms,
				data = EXCLUDED.data,
				updated_at = now()
			`,
      [buildCacheId(type, key), type, key, Date.now(), value],
    );
  } catch (error) {
    console.error(`Failed to write external ${type} cache for ${key}:`, error);
  }
}

/** Reads a bundled seed entry (used to warm an empty cache), or null when none exists. */
async function readSeedCache(type, key) {
  const filePath = path.join(CACHE_SEED_ROOT, `${type}-cache`, `${key}.json`);
  try {
    const entry = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    return entry?.data ?? entry;
  } catch {}
  return null;
}

/** Looks an entry up in the external cache, then the local cache, then the seed files; null on a miss. */
async function readCache(type, key, options = {}) {
  const ttlMs = getTtl(type, options);

  if (usesExternalCache()) {
    const externalEntry = await readExternalCache(type, key, ttlMs);
    if (externalEntry !== null) return externalEntry;
  }

  if (usesLocalCache()) {
    const localEntry = await readLocalCache(type, key, ttlMs);
    if (localEntry !== null) return localEntry;
  }

  const seedEntry = await readSeedCache(type, key);
  if (seedEntry !== null) {
    await writeCache(type, key, seedEntry);
    return seedEntry;
  }

  return null;
}

/** Writes an entry to every enabled cache store. */
async function writeCache(type, key, value) {
  if (usesExternalCache()) {
    await writeExternalCache(type, key, value);
  }
  if (usesLocalCache()) {
    try {
      await writeLocalCache(type, key, value);
    } catch (error) {
      console.error(`Failed to write local ${type} cache for ${key}:`, error);
    }
  }
}

/**
 * Returns the cached value for `type`/`key`, calling `fetcher` on a miss and
 * caching its result. Concurrent misses for the same entry share one fetch.
 */
async function getOrFetchCached(type, key, fetcher, options = {}) {
  const cachedValue = await readCache(type, key, options);
  if (cachedValue !== null) {
    return cachedValue;
  }
  const inFlightKey = buildCacheId(type, key);
  if (inFlightFetches.has(inFlightKey)) {
    return await inFlightFetches.get(inFlightKey);
  }
  const fetchPromise = fetcher()
    .then(async (fetchedValue) => {
      try {
        await writeCache(type, key, fetchedValue);
      } catch (error) {
        console.error(`Failed to write ${type} cache for ${key}:`, error);
      }
      return fetchedValue;
    })
    .finally(() => inFlightFetches.delete(inFlightKey));

  inFlightFetches.set(inFlightKey, fetchPromise);
  return await fetchPromise;
}

/** True when a cache database URL is set. */
async function isExternalCacheConfigured() {
  return Boolean(process.env.CACHE_DATABASE_URL);
}

/** True when the cache database accepts a trivial query. */
async function isExternalCacheReachable() {
  try {
    const pool = await ensureExternalCacheTable();
    if (!pool) return false;
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Reports per-type entry counts and byte sizes of the Postgres cache, or null if unavailable. */
async function getExternalCacheUsage() {
  try {
    const pool = await ensureExternalCacheTable();
    if (!pool) return null;
    const { rows: usageRows } = await pool.query(`
			SELECT
				type,
				COUNT(*)::int AS entries,
				COALESCE(SUM(pg_column_size(data)), 0)::bigint AS bytes
			FROM app_cache
			GROUP BY type
		`);
    const { rows: tableSizeRows } = await pool.query(
      `SELECT pg_total_relation_size('app_cache')::bigint AS table_bytes`,
    );
    const sections = {};
    let totalEntries = 0;
    let totalBytes = 0;
    for (const usageRow of usageRows) {
      const entries = Number(usageRow.entries);
      const bytes = Number(usageRow.bytes);
      sections[usageRow.type] = { entries, bytes };
      totalEntries += entries;
      totalBytes += bytes;
    }
    const tableBytes = Number(tableSizeRows[0]?.table_bytes ?? 0);
    return { sections, totalEntries, totalBytes, tableBytes };
  } catch (error) {
    console.error('Failed to inspect external cache usage:', error);
    return null;
  }
}

/** Totals per-type byte sizes and finds the largest type. */
function summarizeSections(sections) {
  let total = 0;
  for (const size of Object.values(sections)) {
    total += size;
  }
  const largestSection = Object.entries(sections).reduce(
    (largest, [type, size]) => {
      if (size > largest.size) {
        return { type, size };
      }
      return largest;
    },
    { type: null, size: 0 },
  );
  return { sections, largestSection, total };
}

/** Reduces external usage to a map of cache type to bytes. */
function pickExternalByteSections(externalUsage) {
  const sections = {};
  for (const [type, section] of Object.entries(externalUsage.sections)) {
    sections[type] = section.bytes;
  }
  return sections;
}

/** True when the cache root exists (or can be created) and is writable. */
async function isCacheWritable() {
  try {
    await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
    await fs.promises.access(CACHE_ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reports byte sizes of the cache directories, summarized like the external usage. */
async function getLocalCacheUsage() {
  const sections = {};
  for (const [type, dir] of Object.entries(CACHE_DIRS)) {
    sections[type] = await dirSize(dir);
  }
  return summarizeSections(sections);
}

/** Combines local and external cache usage for the diagnostics endpoints. */
async function getCacheUsage() {
  const localUsage = await getLocalCacheUsage();
  const externalUsage = await getExternalCacheUsage();
  let externalSummary = {
    configured: await isExternalCacheConfigured(),
    reachable: false,
    sections: {},
    totalEntries: 0,
    totalBytes: 0,
    tableBytes: 0,
  };
  if (externalUsage) {
    externalSummary = {
      configured: true,
      reachable: true,
      ...externalUsage,
    };
  }

  const useExternalTotals = usesExternalCache();
  const primary =
    useExternalTotals && externalUsage
      ? summarizeSections(pickExternalByteSections(externalUsage))
      : useExternalTotals
        ? summarizeSections({})
        : localUsage;

  return {
    storageMode: getCacheStorageMode(),
    primaryStore: useExternalTotals
      ? CACHE_STORAGE_MODES.POSTGRES
      : CACHE_STORAGE_MODES.FILESYSTEM,
    ...primary,
    local: localUsage,
    external: externalSummary,
  };
}

/** Sums the sizes of the regular files directly inside a directory; 0 if it is unreadable. */
async function dirSize(dir) {
  let total = 0;
  let fileNames;
  try {
    fileNames = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }

  for (const fileName of fileNames) {
    try {
      const stat = await fs.promises.stat(path.join(dir, fileName));
      if (stat.isFile()) {
        total += stat.size;
      }
    } catch {
      continue;
    }
  }
  return total;
}

module.exports = {
  readCache,
  writeCache,
  CACHE_TYPES,
  getOrFetchCached,
  isCacheWritable,
  getCacheStorageMode,
  isExternalCacheConfigured,
  isExternalCacheReachable,
  getCacheUsage,
  closeCachePool,
};
