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
  keyFn: (team) => String(team.teamId),
  onConflict:
    'ON CONFLICT (team_id) DO UPDATE SET tri_code = EXCLUDED.tri_code',
  toParams: (team) => [team.teamId, team.triCode],
};

test('chunk splits into batches of at most `size` and validates size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 500), []);
  assert.deepEqual(chunk([1, 2, 3], 500), [[1, 2, 3]]);
  for (const size of [0, -3, 2.5]) {
    assert.throws(() => chunk([1], size), /positive integer/);
  }
  // The widest domain row binds 22 params; a full statement must stay well
  // under Postgres's 65,535-parameter limit.
  assert.ok(MAX_ROWS_PER_STATEMENT * 22 < 65535);
});

test('dedupeByKey keeps the last row per key in first-seen key order', () => {
  const rows = [
    { id: 3, v: 'a' },
    { id: 1, v: 'b' },
    { id: 3, v: 'c' }, // duplicate key 3: later value wins, position stays
    { id: 2, v: 'd' },
  ];
  assert.deepEqual(
    dedupeByKey(rows, (row) => String(row.id)),
    [
      { id: 3, v: 'c' },
      { id: 1, v: 'b' },
      { id: 2, v: 'd' },
    ],
  );
  // Composite keys and all-unique input.
  const composite = [
    { season: '20252026', tri: 'COL', player: 1 },
    { season: '20252026', tri: 'COL', player: 2 },
    { season: '20252026', tri: 'COL', player: 1 },
  ];
  const key = (row) => JSON.stringify([row.season, row.tri, row.player]);
  assert.equal(dedupeByKey(composite, key).length, 2);
  const unique = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(
    dedupeByKey(unique, (row) => String(row.id)),
    unique,
  );
});

test('buildValuesClause numbers placeholders sequentially with trailing literals', () => {
  assert.equal(buildValuesClause(1, 3), '($1, $2, $3)');
  assert.equal(buildValuesClause(2, 3), '($1, $2, $3), ($4, $5, $6)');
  assert.equal(
    buildValuesClause(2, 2, ['now()']),
    '($1, $2, now()), ($3, $4, now())',
  );
  // No gaps or duplicates: exactly numRows * colsPerRow placeholders.
  const clause = buildValuesClause(7, 11, ['now()']);
  assert.equal(clause.match(/\$\d+/g).length, 77);
  assert.equal(clause.includes('$77'), true);
  assert.equal(clause.includes('$78'), false);
});

test('batchUpsert dedupes, chunks, and skips empty input', async () => {
  const client = fakeClient();
  const written = await batchUpsert(client, teamSpec, [
    { teamId: 1, triCode: 'COL' },
    { teamId: 2, triCode: 'BOS' },
    { teamId: 1, triCode: 'COL' }, // duplicate key
  ]);
  assert.equal(written, 2);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params, [1, 'COL', 2, 'BOS']);
  assert.match(client.calls[0].text, /INSERT INTO teams/);
  assert.match(client.calls[0].text, /ON CONFLICT \(team_id\)/);

  const chunked = fakeClient();
  const rows = Array.from({ length: MAX_ROWS_PER_STATEMENT + 1 }, (_, i) => ({
    teamId: i,
    triCode: `T${i}`,
  }));
  assert.equal(
    await batchUpsert(chunked, teamSpec, rows),
    MAX_ROWS_PER_STATEMENT + 1,
  );
  assert.deepEqual(
    chunked.calls.map((call) => call.params.length),
    [MAX_ROWS_PER_STATEMENT * 2, 2],
  );

  const empty = fakeClient();
  assert.equal(await batchUpsert(empty, teamSpec, []), 0);
  assert.equal(empty.calls.length, 0);
});
