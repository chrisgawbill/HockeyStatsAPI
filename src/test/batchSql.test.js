const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MAX_ROWS_PER_STATEMENT,
  chunk,
  dedupeByKey,
  buildValuesClause,
  batchUpsert,
} = require('#platform/batchSql.js');

// Records every query issued so we can assert on batching/dedupe/params
// without a real database.
function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
}

const teamSpec = {
  table: 'teams',
  columns: ['team_id', 'tri_code'],
  keyFn: (t) => String(t.teamId),
  onConflict:
    'ON CONFLICT (team_id) DO UPDATE SET tri_code = EXCLUDED.tri_code',
  toParams: (t) => [t.teamId, t.triCode],
};

test('chunk splits an array into batches of at most `size`', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [
    [1, 2],
    [3, 4],
  ]);
});

test('chunk returns an empty list for an empty input', () => {
  assert.deepEqual(chunk([], 500), []);
});

test('chunk returns a single batch when size exceeds length', () => {
  assert.deepEqual(chunk([1, 2, 3], 500), [[1, 2, 3]]);
});

test('chunk rejects a non-positive or non-integer size', () => {
  assert.throws(() => chunk([1], 0), /positive integer/);
  assert.throws(() => chunk([1], -3), /positive integer/);
  assert.throws(() => chunk([1], 2.5), /positive integer/);
});

test('MAX_ROWS_PER_STATEMENT stays far below the 65,535 bind-param ceiling', () => {
  // Widest domain row binds 22 params; the batch size must keep a full
  // statement well under Postgres's 65,535-parameter limit.
  const widestParamsPerRow = 22;
  assert.ok(MAX_ROWS_PER_STATEMENT * widestParamsPerRow < 65535);
});

test('dedupeByKey collapses same-key rows, keeping the last occurrence', () => {
  const rows = [
    { id: 1, v: 'a' },
    { id: 2, v: 'b' },
    { id: 1, v: 'c' }, // duplicate key 1 — later value wins
  ];
  assert.deepEqual(
    dedupeByKey(rows, (r) => String(r.id)),
    [
      { id: 1, v: 'c' },
      { id: 2, v: 'b' },
    ],
  );
});

test('dedupeByKey preserves first-seen order of surviving keys', () => {
  const rows = [{ id: 3 }, { id: 1 }, { id: 3 }, { id: 2 }];
  assert.deepEqual(
    dedupeByKey(rows, (r) => String(r.id)).map((r) => r.id),
    [3, 1, 2],
  );
});

test('dedupeByKey supports composite keys (order matters, not just values)', () => {
  const rows = [
    { season: '20252026', tri: 'COL', player: 1 },
    { season: '20252026', tri: 'COL', player: 2 },
    { season: '20252026', tri: 'COL', player: 1 }, // dup composite
  ];
  const key = (r) => JSON.stringify([r.season, r.tri, r.player]);
  assert.equal(dedupeByKey(rows, key).length, 2);
});

test('dedupeByKey leaves an all-unique list untouched', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(
    dedupeByKey(rows, (r) => String(r.id)),
    rows,
  );
});

test('buildValuesClause numbers placeholders sequentially across rows', () => {
  assert.equal(buildValuesClause(1, 3), '($1, $2, $3)');
  assert.equal(buildValuesClause(2, 3), '($1, $2, $3), ($4, $5, $6)');
});

test('buildValuesClause appends trailing literals outside the bind count', () => {
  assert.equal(
    buildValuesClause(2, 2, ['now()']),
    '($1, $2, now()), ($3, $4, now())',
  );
});

test('buildValuesClause placeholder count equals numRows * colsPerRow', () => {
  const numRows = 7;
  const colsPerRow = 11;
  const clause = buildValuesClause(numRows, colsPerRow, ['now()']);
  const placeholders = clause.match(/\$\d+/g);
  assert.equal(placeholders.length, numRows * colsPerRow);
  // highest-numbered placeholder is the total bind count (no gaps/dupes)
  assert.equal(clause.includes(`$${numRows * colsPerRow}`), true);
  assert.equal(clause.includes(`$${numRows * colsPerRow + 1}`), false);
});

test('batchUpsert dedupes by conflict key before writing', async () => {
  const client = fakeClient();
  const written = await batchUpsert(client, teamSpec, [
    { teamId: 1, triCode: 'COL' },
    { teamId: 2, triCode: 'BOS' },
    { teamId: 1, triCode: 'COL' }, // duplicate key
  ]);
  assert.equal(written, 2);
  assert.equal(client.calls.length, 1);
  // 2 unique rows * 2 bound cols = 4 params (updated_at is literal now())
  assert.deepEqual(client.calls[0].params, [1, 'COL', 2, 'BOS']);
  assert.match(client.calls[0].text, /INSERT INTO teams/);
  assert.match(client.calls[0].text, /ON CONFLICT \(team_id\)/);
});

test('batchUpsert splits into one statement per chunk', async () => {
  const client = fakeClient();
  const rows = Array.from({ length: MAX_ROWS_PER_STATEMENT + 1 }, (_, i) => ({
    teamId: i,
    triCode: `T${i}`,
  }));
  const written = await batchUpsert(client, teamSpec, rows);
  assert.equal(written, MAX_ROWS_PER_STATEMENT + 1);
  assert.equal(client.calls.length, 2); // one full chunk + remainder
  assert.equal(client.calls[0].params.length, MAX_ROWS_PER_STATEMENT * 2);
  assert.equal(client.calls[1].params.length, 2);
});

test('batchUpsert issues no query for an empty row set', async () => {
  const client = fakeClient();
  const written = await batchUpsert(client, teamSpec, []);
  assert.equal(written, 0);
  assert.equal(client.calls.length, 0);
});
