const assert = require('node:assert/strict');
const test = require('node:test');

const { buildLines } = require('#slices/lines/mappers/lineBuilder.js');
const { createLineService } = require('#slices/lines/lineService.js');

const sh = (playerId, period, startTime, endTime, extra = {}) => ({
  playerId,
  teamAbbrev: 'COL',
  period,
  startTime,
  endTime,
  typeCode: 517,
  eventDescription: null,
  ...extra,
});
const fw = (id, positionCode) => ({ id, positionCode });
const df = (id, shootsCatches) => ({ id, positionCode: 'D', shootsCatches });

test('overlap math spans periods and ignores goal events', () => {
  const roster = {
    forwards: [fw(1, 'L'), fw(2, 'C'), fw(3, 'R')],
    defensemen: [],
    goalies: [],
  };
  const shifts = [];
  for (const id of [1, 2, 3]) {
    shifts.push(sh(id, 1, '00:00', '00:30'));
    shifts.push(sh(id, 2, '05:00', '05:20'));
  }
  // player 3 leaves 10s early in period 1 -> triple overlap 20 + 20
  shifts[4] = sh(3, 1, '00:00', '00:20');
  // goal event row must be ignored
  shifts.push(
    sh(1, 3, '00:00', '10:00', { typeCode: 505, eventDescription: 'goal' }),
  );
  const out = buildLines({ shifts, rawRoster: roster, triCode: 'COL' });
  assert.equal(out.forwardLines.length, 1);
  assert.equal(out.forwardLines[0].togetherSeconds, 40);
  assert.deepEqual(
    out.forwardLines[0].players.map((p) => [p.id, p.slot]),
    [
      [1, 'LW'],
      [2, 'C'],
      [3, 'RW'],
    ],
  );
});

test('greedy trio picks the best-matched forwards and slots two centers', () => {
  const roster = {
    forwards: [
      fw(1, 'L'),
      fw(2, 'C'),
      fw(3, 'R'),
      fw(4, 'C'),
      fw(5, 'C'),
      fw(6, 'R'),
    ],
    defensemen: [],
    goalies: [],
  };
  const shifts = [
    // line A: 1,2,3 together 0:00-1:00
    ...[1, 2, 3].map((id) => sh(id, 1, '00:00', '01:00')),
    // line B: 4,5,6 together 2:00-2:40 (two centers, one right wing, no left wing)
    ...[4, 5, 6].map((id) => sh(id, 1, '02:00', '02:40')),
  ];
  const out = buildLines({ shifts, rawRoster: roster, triCode: 'COL' });
  assert.equal(out.forwardLines.length, 2);
  assert.deepEqual(
    out.forwardLines[0].players.map((p) => p.id),
    [1, 2, 3],
  );
  assert.equal(out.forwardLines[0].togetherSeconds, 60);
  const b = out.forwardLines[1];
  assert.deepEqual(
    b.players.map((p) => p.slot),
    ['LW', 'C', 'RW'],
  );
  assert.equal(b.togetherSeconds, 40);
  // RW stays natural; exactly one center sits at C, the other fills LW
  assert.equal(b.players[2].id, 6);
  assert.deepEqual(b.players.map((p) => p.id).sort(), [4, 5, 6]);
});

test('defense pairs by shot hand, goalie starter by TOI, non-roster skipped', () => {
  const roster = {
    forwards: [],
    defensemen: [df(10, 'R'), df(11, 'L'), df(12, 'L'), df(13, 'L')],
    goalies: [{ id: 30 }, { id: 31 }],
  };
  const shifts = [
    sh(10, 1, '00:00', '00:40'),
    sh(11, 1, '00:00', '00:40'),
    sh(12, 1, '01:00', '01:30'),
    sh(13, 1, '01:00', '01:30'),
    sh(30, 1, '00:00', '20:00'),
    sh(31, 3, '10:00', '10:30'),
    sh(99, 1, '00:00', '20:00'),
    sh(77, 1, '00:00', '20:00', { teamAbbrev: 'BOS' }),
  ];
  const out = buildLines({ shifts, rawRoster: roster, triCode: 'COL' });
  assert.equal(out.goalies.starterId, 30);
  assert.equal(out.defensePairs.length, 2);
  assert.deepEqual(
    out.defensePairs[0].players.map((p) => [p.id, p.slot]),
    [
      [11, 'LD'],
      [10, 'RD'],
    ],
  );
  assert.equal(out.defensePairs[0].togetherSeconds, 40);
});

test('empty or goal-only input yields null', () => {
  assert.equal(buildLines({ shifts: [], rawRoster: {}, triCode: 'COL' }), null);
  assert.equal(
    buildLines({
      shifts: [
        sh(1, 1, '00:00', '00:00', { typeCode: 505, eventDescription: 'goal' }),
      ],
      rawRoster: {},
      triCode: 'COL',
    }),
    null,
  );
});

// ---- service ----
const CACHE_TYPES = { SHIFTS: 'shifts', ROSTER: 'roster' };
const rosterRaw = {
  forwards: [fw(1, 'L'), fw(2, 'C'), fw(3, 'R')],
  defensemen: [],
  goalies: [{ id: 30 }],
};
const chart = {
  data: [1, 2, 3, 30].map((id) => sh(id, 1, '00:00', '00:30')),
};

function setup({ games, shiftsResult, shiftsError, season = '20262027' }) {
  const calls = { gets: [], cache: [], recent: 0, schedule: 0 };
  const store = new Map();
  const cache = {
    CACHE_TYPES,
    store,
    // In-memory stand-in: writes only when the fetcher resolves, like the real one.
    GetOrFetch: async (type, key, fetcher, opts) => {
      calls.cache.push({ type, key, opts });
      const id = `${type}:${key}`;
      if (store.has(id)) return store.get(id);
      const data = await fetcher();
      store.set(id, data);
      return data;
    },
    readCache: async (type, key) => store.get(`${type}:${key}`) ?? null,
    writeCache: async (type, key, data) => {
      store.set(`${type}:${key}`, data);
    },
  };
  const nhlApi = {
    axiosNhl: { get: async (u) => (calls.gets.push(u), { data: rosterRaw }) },
    axiosNhlShifts: {
      get: async (u) => {
        calls.gets.push(u);
        if (shiftsError) throw shiftsError;
        return { data: shiftsResult ?? chart };
      },
    },
  };
  const scheduleService = {
    getRecentTeamGames: async () => (
      calls.recent++, { games: games.recent ?? [] }
    ),
    getTeamSchedule: async () => (
      calls.schedule++, { games: games.season ?? [] }
    ),
  };
  const service = createLineService({
    nhlApi,
    cache,
    seasons: { getCurrentSeasonId: () => season },
    scheduleService,
    now: () => Date.parse('2026-10-19T12:00:00Z'),
  });
  return { service, calls, store };
}

const game = (over = {}) => ({
  gameId: 2026020010,
  date: '2026-10-18',
  gameTime: '2026-10-18T23:00:00Z',
  homeTeam: 'BOS',
  awayTeam: 'COL',
  gameState: 'OFF',
  ...over,
});

test('OFF game uses the permanent shifts key and returns contract', async () => {
  const { service, calls } = setup({ games: { recent: [game()] } });
  const out = await service.getLines('COL', '20262027');
  const shiftCall = calls.cache.find((c) => c.type === 'shifts');
  assert.equal(shiftCall.key, '2026020010');
  assert.equal(shiftCall.opts, undefined);
  assert.equal(out.source, 'shifts');
  assert.deepEqual(out.game, {
    gameId: 2026020010,
    gameDate: '2026-10-18',
    opponent: 'BOS',
    homeAway: 'away',
  });
  assert.equal(out.goalies.starterId, 30);
  assert.equal(calls.schedule, 0);
  assert.equal(
    calls.cache.find((c) => c.type === 'roster').key,
    'COL_20262027',
  );
});

test('FINAL game uses prelim key with short TTL', async () => {
  const { service, calls } = setup({
    games: { recent: [game({ gameState: 'FINAL' })] },
  });
  await service.getLines('COL', '20262027');
  const shiftCall = calls.cache.find((c) => c.type === 'shifts');
  assert.equal(shiftCall.key, '2026020010_prelim');
  assert.equal(shiftCall.opts.ttlMs, 5 * 60 * 1000);
});

test('empty chart for OFF game is not permanently cached, is remembered briefly, and degrades to none', async () => {
  const { service, calls, store } = setup({
    games: { recent: [game()] },
    shiftsResult: { data: [] },
  });
  const out = await service.getLines('COL', '20262027');
  assert.equal(out.source, 'none');
  assert.equal(out.game, null);
  const shiftKeys = [...store.keys()].filter((k) => k.startsWith('shifts:'));
  assert.deepEqual(shiftKeys, ['shifts:2026020010_prelim']);

  const shiftFetches = () =>
    calls.gets.filter((u) => u.includes('shiftcharts')).length;
  assert.equal(shiftFetches(), 1);
  await service.getLines('COL', '20262027');
  assert.equal(
    shiftFetches(),
    1,
    'second request is served by the negative cache',
  );
});

test('no completed game -> none without fetching shifts; falls back to season schedule', async () => {
  const future = game({ gameState: 'FUT', gameTime: '2026-10-25T23:00:00Z' });
  const { service, calls } = setup({
    games: { recent: [future], season: [future] },
  });
  const out = await service.getLines('COL', '20262027');
  assert.equal(out.source, 'none');
  assert.equal(calls.recent, 1);
  assert.equal(calls.schedule, 1);
  assert.ok(!calls.gets.some((u) => u.includes('shiftcharts')));

  const past = setup({
    games: {
      recent: [],
      season: [
        game({ gameId: 5 }),
        game({ gameId: 6, gameTime: '2026-10-10T23:00:00Z' }),
      ],
    },
  });
  const res = await past.service.getLines('COL', '20262027');
  assert.equal(res.game.gameId, 5);
});

test('past season skips the recent-week lookup', async () => {
  const { service, calls } = setup({ games: { season: [game()] } });
  await service.getLines('COL', '20242025');
  assert.equal(calls.recent, 0);
  assert.equal(calls.schedule, 1);
});

test('shift fetch error degrades to none', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const { service } = setup({
      games: { recent: [game()] },
      shiftsError: new Error('boom'),
    });
    const out = await service.getLines('COL', '20262027');
    assert.equal(out.source, 'none');
    assert.deepEqual(out.goalies, { starterId: null });
  } finally {
    console.error = orig;
  }
});
