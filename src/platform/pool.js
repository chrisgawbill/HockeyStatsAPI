const { Pool } = require('pg');
const {
  getDatabaseUrl,
  getSslConfig,
} = require('#platform/connectionConfig.js');

let dbPool = null;

// Bound how long a connect/query may block so a misconfigured or unreachable
// database fails fast instead of hanging request handlers indefinitely.
const DB_TIMEOUT_MS = Number(process.env.DATABASE_TIMEOUT_MS) || 5000;

/** Lazily creates the shared application database pool. */
function getDbPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL or CACHE_DATABASE_URL is required.');
  }
  if (!dbPool) {
    dbPool = new Pool({
      connectionString,
      ssl: getSslConfig(),
      connectionTimeoutMillis: DB_TIMEOUT_MS,
      statement_timeout: DB_TIMEOUT_MS,
      query_timeout: DB_TIMEOUT_MS,
    });
    dbPool.on('error', (error) => {
      console.error('DB pool error:', error.message);
    });
  }
  return dbPool;
}

/** Runs `callback` with a pooled client and always releases it afterwards. */
async function withDbClient(callback) {
  const client = await getDbPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

/** Runs `callback` inside BEGIN/COMMIT, rolling back and rethrowing on failure. */
async function withTransaction(callback) {
  return await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const callbackResult = await callback(client);
      await client.query('COMMIT');
      return callbackResult;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** Closes the application database pool, if one was created. */
async function closeDbPool() {
  if (!dbPool) {
    return;
  }
  await dbPool.end();
  dbPool = null;
}

module.exports = {
  getDbPool,
  withDbClient,
  withTransaction,
  closeDbPool,
};
