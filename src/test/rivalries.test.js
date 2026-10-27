const assert = require('node:assert/strict');
const { test } = require('node:test');

const { makeTestApp, request } = require('./testApp.js');
const { createRivalryService } = require('#slices/rivalries/rivalryService.js');
const { createRivalriesRouter } = require('#presentation/routes/rivalries.js');

const STORED_RIVALRIES = [
  { team_a: 'BOS', team_b: 'MTL', tier: 'primary', display_name: null },
  { team_a: 'MTL', team_b: 'TOR', tier: 'primary', display_name: null },
  { team_a: 'EDM', team_b: 'CGY', tier: 'primary', display_name: 'Battle of Alberta' },
];

// Fakes the repository query: filters the stored rows by tri-code like the SQL does.
function makeApp() {
  const queries = [];
  const client = {
    async query(sql, [triCode]) {
      queries.push(triCode);
      const rows = STORED_RIVALRIES.filter(
        (row) => triCode === null || [row.team_a, row.team_b].includes(triCode),
      );
      return { rows };
    },
  };
  const rivalryService = createRivalryService({
    withTransaction: (callback) => callback(client),
  });
  return { app: makeTestApp('/rivalries', createRivalriesRouter({ rivalryService })), queries };
}

test('GET /rivalries lists every enabled rivalry with alphabetical team pairs', async () => {
  const { app, queries } = makeApp();
  const { status, body } = await request(app, '/rivalries');
  assert.equal(status, 200);
  assert.deepEqual(queries, [null]);
  assert.deepEqual(body.rivalries.map(({ teams }) => teams), [
    ['BOS', 'MTL'],
    ['MTL', 'TOR'],
    ['CGY', 'EDM'],
  ]);
});

test('a team with no rivalries gets an empty list, not an inferred rival', async () => {
  const { app } = makeApp();
  const { status, body } = await request(app, '/rivalries/SEA');
  assert.equal(status, 200);
  assert.deepEqual(body, { rivalries: [] });
});

test('either team of a pair returns the same relationship', async () => {
  const { app } = makeApp();
  const fromEdmonton = await request(app, '/rivalries/edm');
  const fromCalgary = await request(app, '/rivalries/CGY');
  const battleOfAlberta = {
    teams: ['CGY', 'EDM'],
    tier: 'primary',
    displayName: 'Battle of Alberta',
  };
  assert.deepEqual(fromEdmonton.body.rivalries, [battleOfAlberta]);
  assert.deepEqual(fromCalgary.body.rivalries, [battleOfAlberta]);
});

test('a team with several rivalries gets all of them', async () => {
  const { app } = makeApp();
  const { body } = await request(app, '/rivalries/MTL');
  assert.deepEqual(body.rivalries.map(({ teams }) => teams), [
    ['BOS', 'MTL'],
    ['MTL', 'TOR'],
  ]);
});

test('a malformed tri-code is a 400', async () => {
  const { app, queries } = makeApp();
  const { status } = await request(app, '/rivalries/TORONTO');
  assert.equal(status, 400);
  assert.deepEqual(queries, []);
});
