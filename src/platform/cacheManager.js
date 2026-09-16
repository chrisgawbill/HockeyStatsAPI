var fs = require('fs');
var path = require('path');
const { Pool } = require('pg');
const { getSslConfig } = require('#platform/connectionConfig.js');

const inFlight = new Map();
let cachePool = null;
let cacheTableReady = false;

// How long cache DB connects/queries may take before failing. Keeps the
// health and cache-usage endpoints (and thus the diagnostics page) responsive
// when the cache DB is configured but unreachable.
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
};

const CACHE_TTLS = {
  [CACHE_TYPES.PLAYER]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.ROSTER]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.AI]: 365 * 24 * 60 * 60 * 1000,
  [CACHE_TYPES.SCHEDULE]: 12 * 60 * 60 * 1000,
  [CACHE_TYPES.STANDINGS]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.STAT_LEADERS]: 24 * 60 * 60 * 1000,
  [CACHE_TYPES.TEAM]: 24 * 60 * 60 * 1000,
};

function getTtl(type, options = {}) {
  return options.ttlMs ?? CACHE_TTLS[type];
}

function getCacheStorageMode() {
  const requestedMode = (process.env.CACHE_STORAGE ?? '').trim().toLowerCase();
  if (VALID_CACHE_STORAGE_MODES.has(requestedMode)) {
    return requestedMode;
  }
  return process.env.CACHE_DATABASE_URL
    ? CACHE_STORAGE_MODES.POSTGRES
    : CACHE_STORAGE_MODES.FILESYSTEM;
}

function usesExternalCache() {
  const mode = getCacheStorageMode();
  return (
    Boolean(process.env.CACHE_DATABASE_URL) &&
    (mode === CACHE_STORAGE_MODES.POSTGRES ||
      mode === CACHE_STORAGE_MODES.HYBRID)
  );
}

function usesLocalCache() {
  const mode = getCacheStorageMode();
  return (
    mode === CACHE_STORAGE_MODES.FILESYSTEM ||
    mode === CACHE_STORAGE_MODES.HYBRID
  );
}

function isFresh(timestamp, ttlMs) {
  return ttlMs === Infinity || Date.now() - timestamp < ttlMs;
}

function makeCacheId(type, key) {
  return `${type}:${key}`;
}

function getCachePool() {
  if (!process.env.CACHE_DATABASE_URL) return null;
  if (!cachePool) {
    cachePool = new Pool({
      connectionString: process.env.CACHE_DATABASE_URL,
      ssl: getSslConfig(),
      // Fail fast instead of hanging when the cache DB is configured but
      // unreachable/slow. Without this, health and cache-usage probes block
      // indefinitely and the diagnostics page never loads.
      connectionTimeoutMillis: CACHE_DB_TIMEOUT_MS,
      statement_timeout: CACHE_DB_TIMEOUT_MS,
      query_timeout: CACHE_DB_TIMEOUT_MS,
    });
    // A pool 'error' on an idle client would otherwise crash the process.
    cachePool.on('error', (err) => {
      console.error('Cache DB pool error:', err.message);
    });
  }
  return cachePool;
}

async function closeCachePool() {
  if (!cachePool) {
    return;
  }
  await cachePool.end();
  cachePool = null;
}

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

async function writeLocalCache(type, key, data) {
  const filePath = path.join(CACHE_DIRS[type], `${key}.json`);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(
    filePath,
    JSON.stringify({ timestamp: Date.now(), data }),
  );
}

async function readExternalCache(type, key, ttlMs) {
  try {
    const pool = await ensureExternalCacheTable();
    if (!pool) return null;
    const result = await pool.query(
      'SELECT timestamp_ms, data FROM app_cache WHERE cache_key = $1',
      [makeCacheId(type, key)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!isFresh(Number(row.timestamp_ms), ttlMs)) return null;
    return row.data;
  } catch (error) {
    console.error(`Failed to read external ${type} cache for ${key}:`, error);
    return null;
  }
}

async function writeExternalCache(type, key, data) {
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
      [makeCacheId(type, key), type, key, Date.now(), data],
    );
  } catch (error) {
    console.error(`Failed to write external ${type} cache for ${key}:`, error);
  }
}

async function readSeedCache(type, key) {
  const filePath = path.join(CACHE_SEED_ROOT, `${type}-cache`, `${key}.json`);
  try {
    const entry = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    return entry?.data ?? entry;
  } catch {}
  return null;
}

async function readCache(type, key, options = {}) {
  const ttlMs = getTtl(type, options);

  if (usesExternalCache()) {
    const external = await readExternalCache(type, key, ttlMs);
    if (external !== null) return external;
  }

  if (usesLocalCache()) {
    const local = await readLocalCache(type, key, ttlMs);
    if (local !== null) return local;
  }

  const seed = await readSeedCache(type, key);
  if (seed !== null) {
    await writeCache(type, key, seed);
    return seed;
  }

  return null;
}

async function writeCache(type, key, data) {
  if (usesExternalCache()) {
    await writeExternalCache(type, key, data);
  }
  if (usesLocalCache()) {
    try {
      await writeLocalCache(type, key, data);
    } catch (error) {
      console.error(`Failed to write local ${type} cache for ${key}:`, error);
    }
  }
}

async function GetOrFetch(type, key, fetcher, options = {}) {
  const cached = await readCache(type, key, options);
  if (cached !== null) {
    return cached;
  }
  const inFlightKey = `${type}:${key}`;
  if (inFlight.has(inFlightKey)) {
    return await inFlight.get(inFlightKey);
  }
  const promise = fetcher()
    .then(async (data) => {
      try {
        await writeCache(type, key, data);
      } catch (error) {
        console.error(`Failed to write ${type} cache for ${key}:`, error);
      }
      return data;
    })
    .finally(() => inFlight.delete(inFlightKey));

  inFlight.set(inFlightKey, promise);
  return await promise;
}

async function isExternalCacheConfigured() {
  return Boolean(process.env.CACHE_DATABASE_URL);
}

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

async function getExternalCacheUsage() {
  try {
    const pool = await ensureExternalCacheTable();
    if (!pool) return null;
    const result = await pool.query(`
			SELECT
				type,
				COUNT(*)::int AS entries,
				COALESCE(SUM(pg_column_size(data)), 0)::bigint AS bytes
			FROM app_cache
			GROUP BY type
		`);
    // pg_column_size(data) above is the size of the cached payload only.
    // pg_total_relation_size is the real on-disk footprint of the table,
    // including indexes, TOAST, and per-row overhead, so the diagnostics
    // page can show both "stored data" and "size on disk".
    const tableResult = await pool.query(
      `SELECT pg_total_relation_size('app_cache')::bigint AS table_bytes`,
    );
    const sections = {};
    let totalEntries = 0;
    let totalBytes = 0;
    for (const row of result.rows) {
      const entries = Number(row.entries);
      const bytes = Number(row.bytes);
      sections[row.type] = { entries, bytes };
      totalEntries += entries;
      totalBytes += bytes;
    }
    const tableBytes = Number(tableResult.rows[0]?.table_bytes ?? 0);
    return { sections, totalEntries, totalBytes, tableBytes };
  } catch (error) {
    console.error('Failed to inspect external cache usage:', error);
    return null;
  }
}

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

function getExternalByteSections(externalUsage) {
  const sections = {};
  for (const [type, section] of Object.entries(externalUsage.sections)) {
    sections[type] = section.bytes;
  }
  return sections;
}

async function isCacheWritable() {
  try {
    await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
    await fs.promises.access(CACHE_ROOT, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function getLocalCacheUsage() {
  const sections = {};
  for (const [type, dir] of Object.entries(CACHE_DIRS)) {
    sections[type] = await dirSize(dir);
  }
  return summarizeSections(sections);
}

async function getCacheUsage() {
  const local = await getLocalCacheUsage();
  const externalUsage = await getExternalCacheUsage();
  let external = {
    configured: await isExternalCacheConfigured(),
    reachable: false,
    sections: {},
    totalEntries: 0,
    totalBytes: 0,
    tableBytes: 0,
  };
  if (externalUsage) {
    external = {
      configured: true,
      reachable: true,
      ...externalUsage,
    };
  }

  const useExternalTotals = usesExternalCache();
  const primary =
    useExternalTotals && externalUsage
      ? summarizeSections(getExternalByteSections(externalUsage))
      : useExternalTotals
        ? summarizeSections({})
        : local;

  return {
    storageMode: getCacheStorageMode(),
    primaryStore: useExternalTotals
      ? CACHE_STORAGE_MODES.POSTGRES
      : CACHE_STORAGE_MODES.FILESYSTEM,
    ...primary,
    local,
    external,
  };
}

async function dirSize(dir) {
  let total = 0;
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch (e) {
    return 0;
  }

  for (const file of files) {
    try {
      const stat = await fs.promises.stat(path.join(dir, file));
      if (stat.isFile()) {
        total += stat.size;
      }
    } catch (e) {
      continue;
    }
  }
  return total;
}

module.exports = {
  readCache,
  writeCache,
  CACHE_TYPES,
  GetOrFetch,
  isCacheWritable,
  getCacheStorageMode,
  isExternalCacheConfigured,
  isExternalCacheReachable,
  getCacheUsage,
  closeCachePool,
};
