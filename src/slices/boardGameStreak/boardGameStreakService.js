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
 * @param {{ wins: Record<string, true>, lastWinDate: string|null }} firstStreak
 * @param {{ wins: Record<string, true>, lastWinDate: string|null }} secondStreak
 * @returns {{ wins: Record<string, true>, lastWinDate: string|null }}
 */
function mergeStreaks(firstStreak, secondStreak) {
  const wins = { ...(firstStreak?.wins ?? {}), ...(secondStreak?.wins ?? {}) };
  const lastWinDate = laterDateKey(
    firstStreak?.lastWinDate,
    secondStreak?.lastWinDate,
  );
  return { wins, lastWinDate };
}

/** The later of two ISO date strings; either may be missing. */
function laterDateKey(firstDate, secondDate) {
  if (!firstDate) return secondDate ?? null;
  if (!secondDate) return firstDate;
  return firstDate > secondDate ? firstDate : secondDate;
}

/** Maps a stored streak row to the API shape; a missing row is an empty streak. */
function mapStreakRow(streakRow) {
  if (!streakRow) return { ...EMPTY_STREAK };
  return {
    wins: streakRow.wins ?? {},
    lastWinDate: streakRow.last_win_date ?? null,
  };
}

/** Coerces a request body into a streak, dropping anything malformed. */
function sanitizeStreakInput(incoming) {
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
      const streakRow = await withTransaction((client) =>
        repository.getStreak(client, userId),
      );
      return mapStreakRow(streakRow);
    },

    /**
     * Merges `incoming` with whatever is already stored for `userId` (never a
     * blind overwrite) and persists + returns the merged result.
     * @param {number|string} userId
     * @param {{ wins: Record<string, true>, lastWinDate: string|null }} incoming
     */
    async putStreakForUser(userId, incoming) {
      return await withTransaction(async (client) => {
        const existingStreak = mapStreakRow(
          await repository.getStreak(client, userId),
        );
        const mergedStreak = mergeStreaks(
          existingStreak,
          sanitizeStreakInput(incoming),
        );
        const savedRow = await repository.upsertStreak(client, {
          userId,
          wins: mergedStreak.wins,
          lastWinDate: mergedStreak.lastWinDate,
        });
        return mapStreakRow(savedRow);
      });
    },
  };
}

module.exports = {
  createBoardGameStreakService,
  mergeStreaks,
};
