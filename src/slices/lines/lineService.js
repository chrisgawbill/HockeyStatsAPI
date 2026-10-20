const {
  buildLines,
  emptyLines,
  isShiftRow,
} = require('#slices/lines/mappers/lineBuilder.js');

const PRELIM_SHIFTS_TTL_MS = 5 * 60 * 1000;
const COMPLETED_STATES = new Set(['OFF', 'FINAL']);

class EmptyPayloadError extends Error {
  /** Carries the empty payload so the caller can cache it briefly instead of permanently. */
  constructor(payload) {
    super('NHL payload has no usable rows');
    this.payload = payload;
  }
}

/** True for a final game that has already started (a game with no parseable start counts as started). */
function isCompleted(game, nowMs) {
  if (!COMPLETED_STATES.has(game.gameState)) return false;
  const startMs = Date.parse(game.gameTime);
  return Number.isFinite(startMs) ? startMs <= nowMs : true;
}

/** The most recent completed game by start time, then date; null if none. */
function findLatestCompletedGame(games, nowMs) {
  const completedGames = (games ?? []).filter((game) =>
    isCompleted(game, nowMs),
  );
  completedGames.sort(
    (gameA, gameB) =>
      (Date.parse(gameB.gameTime) || 0) - (Date.parse(gameA.gameTime) || 0) ||
      String(gameB.date).localeCompare(String(gameA.date)),
  );
  return completedGames[0] ?? null;
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
  const { getOrFetchCached, readCache, writeCache, CACHE_TYPES } = cache;
  const clock = now ?? (() => Date.now());

  /**
   * The team's latest completed game: this week's short-TTL schedule first for
   * the current season, then the full season schedule.
   */
  async function findLatestGame(triCode, seasonId) {
    const nowMs = clock();
    if (seasonId === seasons.getCurrentSeasonId()) {
      const { games: recentGames } =
        await scheduleService.getRecentTeamGames(triCode);
      const recentGame = findLatestCompletedGame(recentGames, nowMs);
      if (recentGame) return recentGame;
    }
    const { games: seasonGames } = await scheduleService.getTeamSchedule(
      triCode,
      seasonId,
    );
    return findLatestCompletedGame(seasonGames, nowMs);
  }

  /** Fetches the raw shift chart for a game. */
  async function fetchShifts(gameId) {
    const response = await nhlApi.axiosNhlShifts.get(
      `/shiftcharts?cayenneExp=gameId=${gameId}`,
    );
    return response.data;
  }

  /** True when a shift-chart payload contains at least one real shift. */
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
      const prelimPayload = await readCache(CACHE_TYPES.SHIFTS, prelimKey, {
        ttlMs: PRELIM_SHIFTS_TTL_MS,
      });
      if (prelimPayload && !hasData(prelimPayload)) return prelimPayload;
      try {
        // Throwing from the fetcher makes getOrFetchCached skip the write.
        return await getOrFetchCached(
          CACHE_TYPES.SHIFTS,
          permanentKey,
          async () => {
            const payload = await fetcher();
            if (!hasData(payload)) throw new EmptyPayloadError(payload);
            return payload;
          },
        );
      } catch (error) {
        if (!(error instanceof EmptyPayloadError)) throw error;
        await writeCache(CACHE_TYPES.SHIFTS, prelimKey, error.payload);
        return error.payload;
      }
    }
    return await getOrFetchCached(CACHE_TYPES.SHIFTS, prelimKey, fetcher, {
      ttlMs: PRELIM_SHIFTS_TTL_MS,
    });
  }

  /** The game's shift chart, cached permanently once the game is OFF. */
  const getShiftPayload = (game) =>
    getGamePayload(
      game,
      `${game.gameId}`,
      () => fetchShifts(game.gameId),
      hasShiftRows,
    );

  /** Fetches a game's play-by-play and keeps only the faceoff plays, so the cached payload stays small. */
  async function fetchFaceoffs(gameId) {
    const response = await nhlApi.axiosNhl.get(
      `/gamecenter/${gameId}/play-by-play`,
    );
    const faceoffPlays = (response.data?.plays ?? []).filter(
      (play) => play?.typeDescKey === 'faceoff',
    );
    return { plays: faceoffPlays };
  }

  /** The game's faceoff plays, cached like the shift chart. */
  const getFaceoffPayload = (game) =>
    getGamePayload(
      game,
      `${game.gameId}_faceoffs`,
      () => fetchFaceoffs(game.gameId),
      (payload) => (payload?.plays ?? []).length > 0,
    );

  /** Faceoff plays for the game; they only refine the center pick, so a failure yields []. */
  async function getFaceoffs(game) {
    try {
      const faceoffPayload = await getFaceoffPayload(game);
      return faceoffPayload?.plays ?? [];
    } catch (error) {
      console.error(
        `Play-by-play fetch failed for game ${game.gameId}:`,
        error,
      );
      return [];
    }
  }

  return {
    /** Forward lines, D pairs and starting goalie from the team's latest completed game. */
    async getLines(triCode, seasonId) {
      const game = await findLatestGame(triCode, seasonId);
      if (!game) return emptyLines();

      let shiftPayload;
      let rawRoster;
      let faceoffs;
      try {
        [shiftPayload, faceoffs] = await Promise.all([
          getShiftPayload(game),
          getFaceoffs(game),
        ]);
        rawRoster = await getOrFetchCached(
          CACHE_TYPES.ROSTER,
          `${triCode}_${seasonId}`,
          () =>
            nhlApi.axiosNhl
              .get(`/roster/${triCode}/${seasonId}`)
              .then((response) => response.data),
        );
      } catch (error) {
        console.error(
          `Shift chart fetch failed for game ${game.gameId}:`,
          error,
        );
        return emptyLines();
      }

      const lines = buildLines({
        shifts: shiftPayload?.data ?? [],
        rawRoster,
        triCode,
        faceoffs,
      });
      if (!lines) return emptyLines();

      const isHome = game.homeTeam === triCode;
      return {
        source: 'shifts',
        game: {
          gameId: game.gameId,
          gameDate: game.date,
          opponent: isHome ? game.awayTeam : game.homeTeam,
          homeAway: isHome ? 'home' : 'away',
        },
        ...lines,
      };
    },
  };
}

module.exports = { createLineService, PRELIM_SHIFTS_TTL_MS };
