const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

const {
  mergeStreaks,
} = require('#slices/boardGameStreak/boardGameStreakService.js');

test('mergeStreaks unions disjoint wins from both sides', () => {
  const a = { wins: { '2026-01-01': true }, lastWinDate: '2026-01-01' };
  const b = { wins: { '2026-01-02': true }, lastWinDate: '2026-01-02' };

  const merged = mergeStreaks(a, b);

  assert.deepEqual(merged.wins, {
    '2026-01-01': true,
    '2026-01-02': true,
  });
});

test('mergeStreaks does not duplicate or corrupt overlapping win keys', () => {
  const a = {
    wins: { '2026-01-01': true, '2026-01-02': true },
    lastWinDate: '2026-01-02',
  };
  const b = { wins: { '2026-01-02': true }, lastWinDate: '2026-01-02' };

  const merged = mergeStreaks(a, b);

  assert.deepEqual(merged.wins, {
    '2026-01-01': true,
    '2026-01-02': true,
  });
  assert.equal(Object.keys(merged.wins).length, 2);
});

test('mergeStreaks picks the lexicographically later lastWinDate from either side', () => {
  assert.equal(
    mergeStreaks(
      { wins: {}, lastWinDate: '2026-01-05' },
      { wins: {}, lastWinDate: '2026-01-09' },
    ).lastWinDate,
    '2026-01-09',
  );
  assert.equal(
    mergeStreaks(
      { wins: {}, lastWinDate: '2026-02-01' },
      { wins: {}, lastWinDate: '2026-01-09' },
    ).lastWinDate,
    '2026-02-01',
  );
  assert.equal(
    mergeStreaks({ wins: {}, lastWinDate: null }, { wins: {}, lastWinDate: '2026-01-09' })
      .lastWinDate,
    '2026-01-09',
  );
  assert.equal(
    mergeStreaks({ wins: {}, lastWinDate: '2026-01-09' }, { wins: {}, lastWinDate: null })
      .lastWinDate,
    '2026-01-09',
  );
});

// --- Service-level tests against an in-memory fake of the repository's
// underlying SQL, wired through the same withTransaction contract the real
// pool exposes. Mirrors the cacheManager module-mock technique used in
// routes.test.js: the repository module is swapped in the require cache
// before the service (which requires it internally) is loaded.

function installFakeStreakRepository() {
  const rows = new Map(); // userId -> { user_id, wins, last_win_date }

  const repoPath = require.resolve(
    '#slices/boardGameStreak/boardGameStreakRepository.js',
  );
  delete require.cache[repoPath];
  require.cache[repoPath] = {
    id: repoPath,
    filename: repoPath,
    loaded: true,
    exports: {
      async getStreak(client, userId) {
        return rows.get(userId) ?? null;
      },
      async upsertStreak(client, { userId, wins, lastWinDate }) {
        const row = { user_id: userId, wins, last_win_date: lastWinDate };
        rows.set(userId, row);
        return row;
      },
    },
  };

  return rows;
}

const rows = installFakeStreakRepository();

const servicePath = require.resolve(
  '#slices/boardGameStreak/boardGameStreakService.js',
);
delete require.cache[servicePath];
const { createBoardGameStreakService: createServiceFresh } = require(
  '#slices/boardGameStreak/boardGameStreakService.js',
);

async function fakeWithTransaction(callback) {
  return await callback({});
}

const service = createServiceFresh({ withTransaction: fakeWithTransaction });

beforeEach(() => {
  rows.clear();
});

test('getStreakForUser returns an empty streak when no row exists yet', async () => {
  const result = await service.getStreakForUser('user-1');
  assert.deepEqual(result, { wins: {}, lastWinDate: null });
});

test('putStreakForUser merges into whatever is already stored', async () => {
  await service.putStreakForUser('user-1', {
    wins: { '2026-01-01': true },
    lastWinDate: '2026-01-01',
  });

  const result = await service.putStreakForUser('user-1', {
    wins: { '2026-01-02': true },
    lastWinDate: '2026-01-02',
  });

  assert.deepEqual(result, {
    wins: { '2026-01-01': true, '2026-01-02': true },
    lastWinDate: '2026-01-02',
  });
});

test('putStreakForUser is idempotent for identical input', async () => {
  const input = {
    wins: { '2026-01-01': true, '2026-01-02': true },
    lastWinDate: '2026-01-02',
  };

  const first = await service.putStreakForUser('user-2', input);
  const second = await service.putStreakForUser('user-2', input);

  assert.deepEqual(first, second);
  assert.deepEqual(second, {
    wins: { '2026-01-01': true, '2026-01-02': true },
    lastWinDate: '2026-01-02',
  });
});
