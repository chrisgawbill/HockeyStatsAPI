const {
  buildLines,
  emptyLines,
  isShiftRow,
} = require('#slices/lines/mappers/lineBuilder.js');

const PRELIM_SHIFTS_TTL_MS = 5 * 60 * 1000;
const COMPLETED_STATES = new Set(['OFF', 'FINAL']);

class EmptyPayloadError extends Error {
  constructor(payload) {
    super('NHL payload has no usable rows');
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
 * ROSTER cache key with rosterService), 1 shift chart and 1 play-by-play
 * (faceoff plays only), both shared by both teams of the game and permanent once
 * the game is OFF. Only raw payloads are cached.
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

  /**
   * One game's raw payload under `permanentKey` once the game is OFF, or
   * `${permanentKey}_prelim` for 5 minutes while it is only FINAL. An empty
   * payload for an OFF game is never stored permanently; it is remembered under
   * the prelim key for a few minutes so each page view does not re-ask the NHL
   * (a non-empty prelim copy never short-circuits).
   */
  async function getGamePayload(game, permanentKey, fetcher, hasData) {
    const prelimKey = `${permanentKey}_prelim`;
    if (game.gameState === 'OFF') {
      const prelim = await readCache(CACHE_TYPES.SHIFTS, prelimKey, {
        ttlMs: PRELIM_SHIFTS_TTL_MS,
      });
      if (prelim && !hasData(prelim)) return prelim;
      try {
        // Throwing from the fetcher makes GetOrFetch skip the write.
        return await GetOrFetch(CACHE_TYPES.SHIFTS, permanentKey, async () => {
          const payload = await fetcher();
          if (!hasData(payload)) throw new EmptyPayloadError(payload);
          return payload;
        });
      } catch (error) {
        if (!(error instanceof EmptyPayloadError)) throw error;
        await writeCache(CACHE_TYPES.SHIFTS, prelimKey, error.payload);
        return error.payload;
      }
    }
    return await GetOrFetch(CACHE_TYPES.SHIFTS, prelimKey, fetcher, {
      ttlMs: PRELIM_SHIFTS_TTL_MS,
    });
  }

  const getShiftPayload = (game) =>
    getGamePayload(
      game,
      `${game.gameId}`,
      () => fetchShifts(game.gameId),
      hasShiftRows,
    );

  async function fetchFaceoffs(gameId) {
    const res = await nhlApi.axiosNhl.get(`/gamecenter/${gameId}/play-by-play`);
    // Store only the faceoff plays to keep the cached payload small.
    const plays = (res.data?.plays ?? []).filter(
      (p) => p?.typeDescKey === 'faceoff',
    );
    return { plays };
  }

  const getFaceoffPayload = (game) =>
    getGamePayload(
      game,
      `${game.gameId}_faceoffs`,
      () => fetchFaceoffs(game.gameId),
      (payload) => (payload?.plays ?? []).length > 0,
    );

  // Faceoffs only refine the center pick, so a failure never fails the request.
  async function getFaceoffs(game) {
    try {
      const payload = await getFaceoffPayload(game);
      return payload?.plays ?? [];
    } catch (error) {
      console.error(
        `Play-by-play fetch failed for game ${game.gameId}:`,
        error,
      );
      return [];
    }
  }

  return {
    async getLines(triCode, seasonId) {
      const game = await findGame(triCode, seasonId);
      if (!game) return emptyLines();

      let payload;
      let rawRoster;
      let faceoffs;
      try {
        [payload, faceoffs] = await Promise.all([
          getShiftPayload(game),
          getFaceoffs(game),
        ]);
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
        faceoffs,
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
