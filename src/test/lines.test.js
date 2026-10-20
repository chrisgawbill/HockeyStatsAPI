const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLines,
  faceoffCounts,
} = require('#slices/lines/mappers/lineBuilder.js');
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

test('overlap math spans periods and ignores goal events; no usable shifts is null', () => {
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
  const builtLines = buildLines({ shifts, rawRoster: roster, triCode: 'COL' });
  assert.equal(builtLines.forwardLines.length, 1);
  assert.equal(builtLines.forwardLines[0].togetherSeconds, 40);
  assert.deepEqual(
    builtLines.forwardLines[0].players.map((player) => [player.id, player.slot]),
    [
      [1, 'LW'],
      [2, 'C'],
      [3, 'RW'],
    ],
  );

  // Empty or goal-only input yields null.
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
  const builtLines = buildLines({ shifts, rawRoster: roster, triCode: 'COL' });
  assert.equal(builtLines.forwardLines.length, 2);
  assert.deepEqual(
    builtLines.forwardLines[0].players.map((player) => player.id),
    [1, 2, 3],
  );
  assert.equal(builtLines.forwardLines[0].togetherSeconds, 60);
  const b = builtLines.forwardLines[1];
  assert.deepEqual(
    b.players.map((player) => player.slot),
    ['LW', 'C', 'RW'],
  );
  assert.equal(b.togetherSeconds, 40);
  // RW stays natural; exactly one center sits at C, the other fills LW
  assert.equal(b.players[2].id, 6);
  assert.deepEqual(b.players.map((player) => player.id).sort(), [4, 5, 6]);
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
  const builtLines = buildLines({ shifts, rawRoster: roster, triCode: 'COL' });
  assert.equal(builtLines.goalies.starterId, 30);
  assert.equal(builtLines.defensePairs.length, 2);
  assert.deepEqual(
    builtLines.defensePairs[0].players.map((player) => [player.id, player.slot]),
    [
      [11, 'LD'],
      [10, 'RD'],
    ],
  );
  assert.equal(builtLines.defensePairs[0].togetherSeconds, 40);
});

// ---- faceoff-based centers ----
const draw = (winningPlayerId, losingPlayerId) => ({
  typeDescKey: 'faceoff',
  details: { winningPlayerId, losingPlayerId },
});
const draws = (playerId, n, opponentId = 900) =>
  Array.from({ length: n }, (_, i) =>
    i % 2 ? draw(opponentId, playerId) : draw(playerId, opponentId),
  );

test('faceoff leader is the center even when nobody is a natural C', () => {
  // Cates (1) is listed L, Michkov (2) R with the most TOI, Foerster (3) R.
  const roster = {
    forwards: [
      { ...fw(1, 'L'), shootsCatches: 'L' },
      { ...fw(2, 'R'), shootsCatches: 'R' },
      { ...fw(3, 'R'), shootsCatches: 'L' },
    ],
    defensemen: [],
    goalies: [],
  };
  const shifts = [
    sh(1, 1, '00:00', '00:40'),
    sh(2, 1, '00:00', '00:50'),
    sh(3, 1, '00:00', '00:30'),
  ];
  const slots = (faceoffs) =>
    buildLines({
      shifts,
      rawRoster: roster,
      triCode: 'COL',
      faceoffs,
    }).forwardLines[0].players.map((player) => [player.id, player.slot]);

  assert.deepEqual(slots(draws(1, 12)), [
    [3, 'LW'],
    [1, 'C'],
    [2, 'RW'],
  ]);
  // Same through a pre-counted Map.
  assert.deepEqual(slots(new Map([[1, 12]])), slots(draws(1, 12)));
});

test('without clear faceoff data the highest-TOI player centers; faceoffCounts tallies draws', () => {
  const roster = {
    forwards: [fw(1, 'L'), fw(2, 'R'), fw(3, 'R')],
    defensemen: [],
    goalies: [],
  };
  const shifts = [
    sh(1, 1, '00:00', '00:40'),
    sh(2, 1, '00:00', '00:50'),
    sh(3, 1, '00:00', '00:30'),
  ];
  const centerOf = (faceoffs) =>
    buildLines({
      shifts,
      rawRoster: roster,
      triCode: 'COL',
      faceoffs,
    }).forwardLines[0].players.find((player) => player.slot === 'C').id;
  assert.equal(centerOf(undefined), 2);
  assert.equal(centerOf([]), 2);
  // Too few draws is not a clear leader, but the no-natural-C tie-break
  // still prefers the player with the most faceoffs over TOI.
  assert.equal(centerOf(draws(1, 2)), 1);
  // A tied lead is not clear either: most faceoffs, then TOI, picks the center.
  assert.equal(centerOf([...draws(1, 6), ...draws(3, 6)]), 1);

  const counts = faceoffCounts([
    draw(1, 2),
    draw(2, 1),
    draw(1, 3),
    { typeDescKey: 'shot-on-goal', details: { winningPlayerId: 9 } },
  ]);
  assert.deepEqual(
    [...counts],
    [
      [1, 3],
      [2, 2],
      [3, 1],
    ],
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

function setup({
  games,
  shiftsResult,
  shiftsError,
  pbp,
  pbpError,
  season = '20262027',
}) {
  const calls = { gets: [], cache: [], recent: 0, schedule: 0 };
  const store = new Map();
  const cache = {
    CACHE_TYPES,
    store,
    // In-memory stand-in: writes only when the fetcher resolves, like the real one.
    getOrFetchCached: async (type, key, fetcher, opts) => {
      calls.cache.push({ type, key, opts });
      const id = `${type}:${key}`;
      if (store.has(id)) return store.get(id);
      const value = await fetcher();
      store.set(id, value);
      return value;
    },
    readCache: async (type, key) => store.get(`${type}:${key}`) ?? null,
    writeCache: async (type, key, value) => {
      store.set(`${type}:${key}`, value);
    },
  };
  const nhlApi = {
    axiosNhl: {
      get: async (url) => {
        calls.gets.push(url);
        if (url.includes('play-by-play')) {
          if (pbpError) throw pbpError;
          return { data: pbp ?? { plays: [] } };
        }
        return { data: rosterRaw };
      },
    },
    axiosNhlShifts: {
      get: async (url) => {
        calls.gets.push(url);
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

const pbpPayload = {
  plays: [
    { typeDescKey: 'shot-on-goal', details: { shootingPlayerId: 1 } },
    ...draws(2, 6, 900),
    { typeDescKey: 'goal', details: {} },
  ],
  rosterSpots: [{ playerId: 1 }],
};

test('OFF games use permanent shift/faceoff keys, FINAL games 5-minute prelim keys', async () => {
  const { service, calls, store } = setup({
    games: { recent: [game()] },
    pbp: pbpPayload,
  });
  const servedLines = await service.getLines('COL', '20262027');
  const shiftCall = calls.cache.find(
    (c) => c.type === 'shifts' && c.key === '2026020010',
  );
  assert.ok(shiftCall);
  assert.equal(shiftCall.opts, undefined);
  assert.equal(servedLines.source, 'shifts');
  assert.deepEqual(servedLines.game, {
    gameId: 2026020010,
    gameDate: '2026-10-18',
    opponent: 'BOS',
    homeAway: 'away',
  });
  assert.equal(servedLines.goalies.starterId, 30);
  assert.equal(calls.schedule, 0);
  assert.equal(
    calls.cache.find((c) => c.type === 'roster').key,
    'COL_20262027',
  );

  // Faceoff plays: permanent for OFF, and only faceoff plays are stored.
  assert.ok(calls.gets.includes('/gamecenter/2026020010/play-by-play'));
  const offFaceoffs = calls.cache.find((c) => c.key === '2026020010_faceoffs');
  assert.equal(offFaceoffs.opts, undefined);
  const stored = store.get('shifts:2026020010_faceoffs');
  assert.deepEqual(Object.keys(stored), ['plays']);
  assert.equal(stored.plays.length, 6);
  assert.ok(stored.plays.every((play) => play.typeDescKey === 'faceoff'));

  const fin = setup({
    games: { recent: [game({ gameState: 'FINAL' })] },
    pbp: pbpPayload,
  });
  await fin.service.getLines('COL', '20262027');
  for (const key of ['2026020010_prelim', '2026020010_faceoffs_prelim']) {
    const call = fin.calls.cache.find((c) => c.key === key);
    assert.equal(call.opts.ttlMs, 5 * 60 * 1000, key);
  }
});

test('empty shift charts and play-by-play are not cached permanently but remembered briefly', async () => {
  const { service, calls, store } = setup({
    games: { recent: [game()] },
    shiftsResult: { data: [] },
  });
  const servedLines = await service.getLines('COL', '20262027');
  assert.equal(servedLines.source, 'none');
  assert.equal(servedLines.game, null);
  const shiftKeys = [...store.keys()].filter(
    (cacheKey) =>
      cacheKey.startsWith('shifts:') && !cacheKey.includes('_faceoffs'),
  );
  assert.deepEqual(shiftKeys, ['shifts:2026020010_prelim']);

  const shiftFetches = () =>
    calls.gets.filter((url) => url.includes('shiftcharts')).length;
  assert.equal(shiftFetches(), 1);
  await service.getLines('COL', '20262027');
  assert.equal(
    shiftFetches(),
    1,
    'second request is served by the negative cache',
  );

  // An empty play-by-play keeps the shift lines.
  const pbp = setup({
    games: { recent: [game()] },
    pbp: { plays: [] },
  });
  const pbpOut = await pbp.service.getLines('COL', '20262027');
  assert.equal(pbpOut.source, 'shifts');
  assert.ok(!pbp.store.has('shifts:2026020010_faceoffs'));
  assert.ok(pbp.store.has('shifts:2026020010_faceoffs_prelim'));

  const pbpFetches = () =>
    pbp.calls.gets.filter((url) => url.includes('play-by-play')).length;
  assert.equal(pbpFetches(), 1);
  await pbp.service.getLines('COL', '20262027');
  assert.equal(
    pbpFetches(),
    1,
    'second request is served by the negative cache',
  );
});

test('game selection: latest completed game, season fallback, past seasons skip the recent week', async () => {
  const future = game({ gameState: 'FUT', gameTime: '2026-10-25T23:00:00Z' });
  const { service, calls } = setup({
    games: { recent: [future], season: [future] },
  });
  const servedLines = await service.getLines('COL', '20262027');
  assert.equal(servedLines.source, 'none');
  assert.equal(calls.recent, 1);
  assert.equal(calls.schedule, 1);
  assert.ok(!calls.gets.some((url) => url.includes('shiftcharts')));

  const past = setup({
    games: {
      recent: [],
      season: [
        game({ gameId: 5 }),
        game({ gameId: 6, gameTime: '2026-10-10T23:00:00Z' }),
      ],
    },
  });
  const pastLines = await past.service.getLines('COL', '20262027');
  assert.equal(pastLines.game.gameId, 5);

  const pastSeason = setup({ games: { season: [game()] } });
  await pastSeason.service.getLines('COL', '20242025');
  assert.equal(pastSeason.calls.recent, 0);
  assert.equal(pastSeason.calls.schedule, 1);
});

test('a shift fetch error degrades to none; a play-by-play error keeps shift lines', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const { service } = setup({
      games: { recent: [game()] },
      shiftsError: new Error('boom'),
    });
    const servedLines = await service.getLines('COL', '20262027');
    assert.equal(servedLines.source, 'none');
    assert.deepEqual(servedLines.goalies, { starterId: null });

    const pbpDown = setup({
      games: { recent: [game()] },
      pbpError: new Error('pbp down'),
    });
    const lines = await pbpDown.service.getLines('COL', '20262027');
    assert.equal(lines.source, 'shifts');
    assert.equal(lines.forwardLines.length, 1);
  } finally {
    console.error = orig;
  }
});
