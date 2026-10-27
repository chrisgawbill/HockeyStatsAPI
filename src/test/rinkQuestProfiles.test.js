const assert = require('node:assert/strict');
const { test } = require('node:test');

const { makeTestApp, request } = require('./testApp.js');
const {
  createRinkQuestProfileService,
} = require('#slices/rinkQuestProfiles/rinkQuestProfileService.js');
const { createRinkQuestRouter } = require('#presentation/routes/rinkQuest.js');

const ENABLED_TEAM_PROFILES = [
  {
    team_id: 8,
    tri_code: 'MTL',
    full_name: 'Montréal Canadiens',
    logo_url: 'https://assets.nhle.com/logos/nhl/svg/MTL_light.svg',
    primary_identity: 'transition',
    secondary_identity: 'forecheck',
  },
  {
    team_id: 10,
    tri_code: 'TOR',
    full_name: null,
    logo_url: null,
    primary_identity: 'possession',
    secondary_identity: null,
  },
];

const MTL_CANDIDATES = [
  {
    player_id: '8481540',
    full_name: 'Cole Caufield',
    position_code: 'R',
    sweater_number: 13,
    headshot_url: null,
    archetype: 'finisher',
    appearance_rank: 1,
  },
];

// Fakes the repository queries: team lookups filter by tri-code like the SQL
// does; the candidate query is answered from MTL_CANDIDATES.
function makeApp({ refreshRoster = async () => {} } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('rink_quest_team_profiles')) {
        const [triCode] = params;
        calls.push(['teams', triCode]);
        return {
          rows: ENABLED_TEAM_PROFILES.filter((row) => triCode === null || row.tri_code === triCode),
        };
      }
      calls.push(['candidates', ...params]);
      return { rows: params[1] === 'MTL' ? MTL_CANDIDATES : [] };
    },
  };
  const rinkQuestProfileService = createRinkQuestProfileService({
    withTransaction: (callback) => callback(client),
    seasons: { getCurrentSeasonId: () => '20262027' },
    rosterService: {
      async refreshRoster(triCode, seasonId) {
        calls.push(['refresh', triCode, seasonId]);
        return refreshRoster();
      },
    },
  });
  const app = makeTestApp('/rink-quest', createRinkQuestRouter({ rinkQuestProfileService }));
  return { app, calls };
}

test('GET /rink-quest/teams lists enabled team profiles with joined team fields', async () => {
  const { app } = makeApp();
  const { status, body } = await request(app, '/rink-quest/teams');
  assert.equal(status, 200);
  assert.deepEqual(body.teams[1], {
    teamId: 10,
    triCode: 'TOR',
    name: null,
    logoUrl: null,
    primaryIdentity: 'possession',
    secondaryIdentity: null,
  });
  assert.deepEqual(body.teams.map(({ triCode }) => triCode), ['MTL', 'TOR']);
});

test('candidates refresh the current roster, then return stable ids and a nullable headshot', async () => {
  const { app, calls } = makeApp();
  const { status, body } = await request(app, '/rink-quest/teams/mtl/candidates');
  assert.equal(status, 200);
  assert.deepEqual(calls, [
    ['teams', 'MTL'],
    ['refresh', 'MTL', '20262027'],
    ['candidates', '20262027', 'MTL'],
  ]);
  assert.equal(body.team.primaryIdentity, 'transition');
  assert.deepEqual(body.candidates, [
    {
      playerId: 8481540,
      name: 'Cole Caufield',
      positionCode: 'R',
      sweaterNumber: 13,
      headshotUrl: null,
      archetype: 'finisher',
      appearanceRank: 1,
    },
  ]);
});

test('a failed roster refresh still answers from the stored roster', async () => {
  const { app } = makeApp({
    refreshRoster: async () => {
      throw new Error('NHL down');
    },
  });
  const { status, body } = await request(app, '/rink-quest/teams/MTL/candidates');
  assert.equal(status, 200);
  assert.equal(body.candidates.length, 1);
});

test('an enabled team with no eligible profiles gets an empty list, not invented players', async () => {
  const { app } = makeApp();
  const { status, body } = await request(app, '/rink-quest/teams/TOR/candidates');
  assert.equal(status, 200);
  assert.deepEqual(body.candidates, []);
});

test('a team without an enabled profile is a 404 and fetches no roster', async () => {
  const { app, calls } = makeApp();
  const { status } = await request(app, '/rink-quest/teams/SEA/candidates');
  assert.equal(status, 404);
  assert.deepEqual(calls, [['teams', 'SEA']]);
});

test('a malformed tri-code is a 400', async () => {
  const { app, calls } = makeApp();
  const { status } = await request(app, '/rink-quest/teams/TORONTO/candidates');
  assert.equal(status, 400);
  assert.deepEqual(calls, []);
});
