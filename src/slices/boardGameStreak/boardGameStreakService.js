const repository = require('#slices/boardGameStreak/boardGameStreakRepository.js');

const EMPTY_STREAK = Object.freeze({ wins: {}, lastWinDate: null });

/**
 * Server-side merge of two `StreakData` values (see
 * `react/src/features/board-game/data/dailyStreak.ts`): a win recorded on
 * either side is never lost (union of `wins` keys), and `lastWinDate` is the
 * lexicographically later of the two ISO date strings (ISO dates sort
 * lexicographically, so string comparison is correct and avoids a Date
 * parse). Every `wins` value is the literal `true`, so overlapping keys never
 * conflict — there is nothing to reconcile beyond "the key is present".
 *
 * @param {{ wins: Record<string, true>, lastWinDate: string|null }} a
 * @param {{ wins: Record<string, true>, lastWinDate: string|null }} b
 * @returns {{ wins: Record<string, true>, lastWinDate: string|null }}
 */
function mergeStreaks(a, b) {
  const wins = { ...(a?.wins ?? {}), ...(b?.wins ?? {}) };
  const lastWinDate = laterDateKey(a?.lastWinDate, b?.lastWinDate);
  return { wins, lastWinDate };
}

function laterDateKey(x, y) {
  if (!x) return y ?? null;
  if (!y) return x;
  return x > y ? x : y;
}

/**
 * Board game streak slice service: reads and merge-writes the per-user daily
 * streak used to back up/sync `localStorage`-only client state.
 *
 * @param {{ withTransaction: typeof import('#platform/pool.js').withTransaction }} deps
 */
function createBoardGameStreakService({ withTransaction }) {
  return {
    /**
     * @param {number|string} userId
     * @returns {Promise<{ wins: Record<string, true>, lastWinDate: string|null }>}
     */
    async getStreakForUser(userId) {
      const row = await withTransaction((client) =>
        repository.getStreak(client, userId),
      );
      if (!row) {
        return { ...EMPTY_STREAK };
      }
      return { wins: row.wins ?? {}, lastWinDate: row.last_win_date ?? null };
    },

    /**
     * Merges `incoming` with whatever is already stored for `userId` (never a
     * blind overwrite) and persists + returns the merged result.
     * @param {number|string} userId
     * @param {{ wins: Record<string, true>, lastWinDate: string|null }} incoming
     */
    async putStreakForUser(userId, incoming) {
      return await withTransaction(async (client) => {
        const existingRow = await repository.getStreak(client, userId);
        const existing = existingRow
          ? { wins: existingRow.wins ?? {}, lastWinDate: existingRow.last_win_date ?? null }
          : EMPTY_STREAK;

        const merged = mergeStreaks(existing, normalizeStreakInput(incoming));

        const saved = await repository.upsertStreak(client, {
          userId,
          wins: merged.wins,
          lastWinDate: merged.lastWinDate,
        });

        return { wins: saved.wins ?? {}, lastWinDate: saved.last_win_date ?? null };
      });
    },
  };
}

function normalizeStreakInput(incoming) {
  const wins =
    incoming && typeof incoming.wins === 'object' && incoming.wins !== null
      ? incoming.wins
      : {};
  const lastWinDate =
    incoming && typeof incoming.lastWinDate === 'string'
      ? incoming.lastWinDate
      : null;
  return { wins, lastWinDate };
}

module.exports = {
  createBoardGameStreakService,
  mergeStreaks,
};
