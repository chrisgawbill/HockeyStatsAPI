const {
  buildLines,
  emptyLines,
  isShiftRow,
} = require('#slices/lines/mappers/lineBuilder.js');

const PRELIM_SHIFTS_TTL_MS = 5 * 60 * 1000;
const COMPLETED_STATES = new Set(['OFF', 'FINAL']);

class EmptyShiftChartError extends Error {
  constructor(payload) {
    super('Shift chart has no shift rows');
    this.payload = payload;
  }
}

function isCompleted(game, nowMs) {
  if (!COMPLETED_STATES.has(game.gameState)) return false;
  const start = Date.parse(game.gameTime);
  return Number.isFinite(start) ? start <= nowMs : true;
}

function latestCompleted(games, nowMs) {
  const done = (games ?? []).filter((g) => isCompleted(g, nowMs));
  done.sort(
    (a, b) =>
      (Date.parse(b.gameTime) || 0) - (Date.parse(a.gameTime) || 0) ||
      String(b.date).localeCompare(String(a.date)),
  );
  return done[0] ?? null;
}

/**
 * Lines slice: real forward lines / D pairs / starting goalie from the latest
 * completed game's shift chart.
 *
 * Call budget per cold request: 0-1 schedule (shared caches), 1 roster (shared
 * ROSTER cache key with rosterService), 1 shift chart (shared by both teams of
 * the game; permanent once the game is OFF). Only raw payloads are cached.
 *
 * @param {{ nhlApi: any, cache: any, seasons: any, scheduleService: any, now?: () => number }} deps
 */
function createLineService({ nhlApi, cache, seasons, scheduleService, now }) {
  const { GetOrFetch, readCache, writeCache, CACHE_TYPES } = cache;
  const clock = now ?? (() => Date.now());

  async function findGame(triCode, seasonId) {
    const nowMs = clock();
    if (seasonId === seasons.getCurrentSeasonId()) {
      const { games } = await scheduleService.getRecentTeamGames(triCode);
      const recent = latestCompleted(games, nowMs);
      if (recent) return recent;
    }
    const { games } = await scheduleService.getTeamSchedule(triCode, seasonId);
    return latestCompleted(games, nowMs);
  }

  async function fetchShifts(gameId) {
    const res = await nhlApi.axiosNhlShifts.get(
      `/shiftcharts?cayenneExp=gameId=${gameId}`,
    );
    return res.data;
  }

  const hasShiftRows = (payload) => (payload?.data ?? []).some(isShiftRow);

  async function getShiftPayload(game) {
    const gameId = game.gameId;
    const prelimKey = `${gameId}_prelim`;
    if (game.gameState === 'OFF') {
      // An official game whose chart the NHL has not published yet is
      // remembered as empty for a few minutes so each page view does not
      // re-ask the NHL; a non-empty prelim copy never short-circuits.
      const prelim = await readCache(CACHE_TYPES.SHIFTS, prelimKey, {
        ttlMs: PRELIM_SHIFTS_TTL_MS,
      });
      if (prelim && !hasShiftRows(prelim)) return prelim;
      try {
        // Never store an incomplete chart under the permanent key: throwing
        // from the fetcher makes GetOrFetch skip the write.
        return await GetOrFetch(CACHE_TYPES.SHIFTS, `${gameId}`, async () => {
          const payload = await fetchShifts(gameId);
          if (!hasShiftRows(payload)) throw new EmptyShiftChartError(payload);
          return payload;
        });
      } catch (error) {
        if (!(error instanceof EmptyShiftChartError)) throw error;
        const empty = error.payload ?? { data: [] };
        await writeCache(CACHE_TYPES.SHIFTS, prelimKey, empty);
        return empty;
      }
    }
    return await GetOrFetch(
      CACHE_TYPES.SHIFTS,
      prelimKey,
      () => fetchShifts(gameId),
      { ttlMs: PRELIM_SHIFTS_TTL_MS },
    );
  }

  return {
    async getLines(triCode, seasonId) {
      const game = await findGame(triCode, seasonId);
      if (!game) return emptyLines();

      let payload;
      let rawRoster;
      try {
        payload = await getShiftPayload(game);
        rawRoster = await GetOrFetch(
          CACHE_TYPES.ROSTER,
          `${triCode}_${seasonId}`,
          () =>
            nhlApi.axiosNhl
              .get(`/roster/${triCode}/${seasonId}`)
              .then((r) => r.data),
        );
      } catch (error) {
        console.error(
          `Shift chart fetch failed for game ${game.gameId}:`,
          error,
        );
        return emptyLines();
      }

      const built = buildLines({
        shifts: payload?.data ?? [],
        rawRoster,
        triCode,
      });
      if (!built) return emptyLines();

      const isHome = game.homeTeam === triCode;
      return {
        source: 'shifts',
        game: {
          gameId: game.gameId,
          gameDate: game.date,
          opponent: isHome ? game.awayTeam : game.homeTeam,
          homeAway: isHome ? 'home' : 'away',
        },
        ...built,
      };
    },
  };
}

module.exports = { createLineService, PRELIM_SHIFTS_TTL_MS };
