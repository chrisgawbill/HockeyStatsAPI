/**
 * Shared helpers for multi-row `INSERT ... VALUES (...),(...) ON CONFLICT` upserts.
 *
 * The domain persist services collapse thousands of sequential single-row
 * upserts into a handful of batched statements. Two invariants make that safe,
 * and both live here so they are unit-testable in isolation:
 *
 *  - `dedupeByKey` — a single ON CONFLICT statement may not affect the same
 *    target row twice ("cannot affect row a second time"), so rows sharing a
 *    conflict key must be collapsed to one before the statement is built.
 *  - `chunk` / `MAX_ROWS_PER_STATEMENT` — Postgres allows at most 65,535 bind
 *    parameters per query (16-bit wire count), so the VALUES list is split into
 *    batches that stay far below that ceiling.
 */

// Our widest row (team_season_snapshots) binds 22 params/row; 500 rows is
// 11,000 params — comfortably below the 65,535 ceiling with room to spare.
const MAX_ROWS_PER_STATEMENT = 500;

/**
 * Split `rows` into consecutive sub-arrays of at most `size` elements.
 * @template T
 * @param {T[]} rows
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(rows, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/**
 * Collapse rows sharing a conflict key to a single row, keeping the LAST
 * occurrence — matching the sequential single-row loop, where a later upsert
 * overwrote an earlier one for the same key. Insertion order of the surviving
 * rows is preserved (a Map keeps first-seen key order; re-setting an existing
 * key updates the value in place without reordering).
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyFn maps a row to its conflict-key string
 * @returns {T[]}
 */
function dedupeByKey(rows, keyFn) {
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(keyFn(row), row);
  }
  return Array.from(byKey.values());
}

/**
 * Build a multi-row VALUES clause with sequentially numbered bind placeholders,
 * followed by any literal SQL columns (e.g. `now()` for updated_at) that are not
 * bound parameters.
 *
 * buildValuesClause(2, 3, ['now()']) =>
 *   "($1, $2, $3, now()), ($4, $5, $6, now())"
 *
 * @param {number} numRows
 * @param {number} colsPerRow number of bound columns per row
 * @param {string[]} [trailingLiterals] literal SQL appended after the bound cols
 * @returns {string}
 */
function buildValuesClause(numRows, colsPerRow, trailingLiterals = []) {
  const tuples = [];
  let param = 1;
  for (let r = 0; r < numRows; r++) {
    const placeholders = [];
    for (let c = 0; c < colsPerRow; c++) {
      placeholders.push(`$${param++}`);
    }
    tuples.push(`(${[...placeholders, ...trailingLiterals].join(', ')})`);
  }
  return tuples.join(', ');
}

/**
 * Run a chunked, deduped multi-row upsert. Dedupes `rows` by their conflict key,
 * then issues one `INSERT ... VALUES (...),(...) ON CONFLICT ...` statement per
 * chunk. Every domain table's `updated_at` is set with a literal `now()`, so the
 * column is appended automatically and is not a bound parameter.
 *
 * @param {import('pg').ClientBase} client an open pg client (inside a transaction)
 * @param {object} spec
 * @param {string} spec.table target table name
 * @param {string[]} spec.columns bound columns, in the same order as `toParams`
 * @param {(row: object) => string} spec.keyFn maps a row to its conflict key
 * @param {string} spec.onConflict the full `ON CONFLICT ... DO UPDATE SET ...` clause
 * @param {(row: object) => any[]} spec.toParams maps a row to its ordered bind values
 * @param {object[]} rows
 * @returns {Promise<number>} count of unique rows written (post-dedupe)
 */
async function batchUpsert(
  client,
  { table, columns, keyFn, onConflict, toParams },
  rows,
) {
  const unique = dedupeByKey(rows, keyFn);
  for (const batch of chunk(unique, MAX_ROWS_PER_STATEMENT)) {
    const values = buildValuesClause(batch.length, columns.length, ['now()']);
    await client.query(
      `
			INSERT INTO ${table} (${columns.join(', ')}, updated_at)
			VALUES ${values}
			${onConflict}
			`,
      batch.flatMap(toParams),
    );
  }
  return unique.length;
}

module.exports = {
  MAX_ROWS_PER_STATEMENT,
  chunk,
  dedupeByKey,
  buildValuesClause,
  batchUpsert,
};
