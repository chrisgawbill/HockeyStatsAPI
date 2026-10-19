const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  mergeStreaks,
} = require('#slices/boardGameStreak/boardGameStreakService.js');

test('mergeStreaks unions wins without duplicates and keeps the later lastWinDate', () => {
  const merged = mergeStreaks(
    {
      wins: { '2026-01-01': true, '2026-01-02': true },
      lastWinDate: '2026-01-02',
    },
    { wins: { '2026-01-02': true, '2026-01-03': true }, lastWinDate: '2026-01-03' },
  );
  assert.deepEqual(merged.wins, {
    '2026-01-01': true,
    '2026-01-02': true,
    '2026-01-03': true,
  });

  const last = (a, b) =>
    mergeStreaks({ wins: {}, lastWinDate: a }, { wins: {}, lastWinDate: b })
      .lastWinDate;
  assert.equal(last('2026-01-05', '2026-01-09'), '2026-01-09');
  assert.equal(last('2026-02-01', '2026-01-09'), '2026-02-01');
  assert.equal(last(null, '2026-01-09'), '2026-01-09');
  assert.equal(last('2026-01-09', null), '2026-01-09');
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

test('service reads an empty streak, merges puts into storage, and is idempotent', async () => {
  assert.deepEqual(await service.getStreakForUser('user-1'), {
    wins: {},
    lastWinDate: null,
  });

  await service.putStreakForUser('user-1', {
    wins: { '2026-01-01': true },
    lastWinDate: '2026-01-01',
  });
  const input = { wins: { '2026-01-02': true }, lastWinDate: '2026-01-02' };
  const expected = {
    wins: { '2026-01-01': true, '2026-01-02': true },
    lastWinDate: '2026-01-02',
  };
  assert.deepEqual(await service.putStreakForUser('user-1', input), expected);
  assert.deepEqual(await service.putStreakForUser('user-1', input), expected);
  assert.deepEqual(await service.getStreakForUser('user-1'), expected);
});
