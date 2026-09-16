/**
 * scheduleMapper
 *
 * Translates raw NHL schedule games into the app's stable ScheduleGameContract.
 * Serves BOTH schedule sources, which supply the date differently:
 *   - /schedule/        -> weekly endpoint, games nested under gameWeek[].games[],
 *                          date/dayAbbrev live on the WEEK (pass them in via ctx).
 *   - /team/schedule/.. -> club-schedule endpoint, each game has its own gameDate.
 *
 * Field sourcing mirrors react/src/Data/Helpers/ScheduleHelper.ts so the moved
 * logic stays behaviorally identical. All NHL-field knowledge lives here ONCE;
 * the frontend consumes this contract, never raw NHL JSON.
 */

/**
 * @typedef {Object} GameBroadcastContract
 * @property {number|null} id
 * @property {string}      network       - NHL "network" (defensive: "" if missing)
 * @property {string}      market        - e.g. "N" (national) / "H" / "A"
 * @property {string}      countryCode
 */

/**
 * @typedef {Object} ScheduleGameContract
 * @property {number}      gameId
 * @property {string}      date          - YYYY-MM-DD (week date or game's gameDate)
 * @property {string}      gameTime      - startTimeUTC
 * @property {string}      dayOfWeek     - dayAbbrev (e.g. "Mon")
 * @property {string}      venue
 * @property {string}      homeTeam      - abbrev
 * @property {string}      homeLogo
 * @property {number|null} homeScore
 * @property {string}      awayTeam      - abbrev
 * @property {string}      awayLogo
 * @property {number|null} awayScore
 * @property {GameBroadcastContract[]} broadcasts
 * @property {string}      ticketLink    - only for future games, else ""
 * @property {string}      gameCenter    - gameCenterLink
 * @property {boolean}     isPlayoff     - gameType === 3
 * @property {boolean}     isPreseason   - gameType === 1
 * @property {number|null} playoffRound
 * @property {string|null} periodType    - periodDescriptor.periodType
 * @property {string|null} seriesWins    - "top-bottom" wins, e.g. "3-2"
 * @property {string|null} topSeedTeamAbbrev
 * @property {string|null} bottomSeedTeamAbbrev
 * @property {string}      gameState     - FUT / PRE / OFF / FINAL ...
 */

/**
 * Map raw NHL tvBroadcasts into broadcast contracts.
 * Mirrors ScheduleHelper.ts -> ConvertToListOfBroadcasts.
 * @param {any[]} [rawBroadcasts]
 * @returns {GameBroadcastContract[]}
 */
function mapBroadcasts(rawBroadcasts = []) {
  return rawBroadcasts.filter(Boolean).map((b) => {
    const id = b.id ?? null;
    const network = b.network ?? '';
    const market = b.market ?? '';
    const countryCode = b.countryCode ?? '';

    return { id, network, market, countryCode };
  });
}

/**
 * Derive the playoff round.
 * Prefer seriesStatus.round; fall back to digits 7-8 of a 10-char game id.
 * @param {any} rawGame
 * @returns {number|null}
 */
function derivePlayoffRound(rawGame) {
  if (rawGame.seriesStatus?.round != null) {
    return rawGame.seriesStatus.round;
  }
  const idStr = String(rawGame.id ?? '');
  return idStr.length === 10 ? parseInt(idStr.slice(6, 8)) || null : null;
}

/**
 * Map a single raw NHL game into a ScheduleGameContract.
 * Mirrors ScheduleHelper.ts -> ConvertWeekToGames (one game iteration).
 * @param {any} rawGame
 * @param {{ date: string, dayAbbrev: string }} ctx - date/day supplied by the caller
 * @returns {ScheduleGameContract}
 */
function mapGame(rawGame, ctx) {
  const gameState = rawGame.gameState;
  const gameId = rawGame.id;
  const date = ctx.date;
  const gameTime = rawGame.startTimeUTC;
  const dayOfWeek = ctx.dayAbbrev;
  const venue = rawGame.venue?.default ?? '';
  const homeTeam = rawGame.homeTeam?.abbrev ?? '';
  const homeLogo = rawGame.homeTeam?.logo ?? '';
  const homeScore = rawGame.homeTeam?.score ?? null;
  const awayTeam = rawGame.awayTeam?.abbrev ?? '';
  const awayLogo = rawGame.awayTeam?.logo ?? '';
  const awayScore = rawGame.awayTeam?.score ?? null;
  const broadcasts = mapBroadcasts(rawGame.tvBroadcasts);
  const ticketLink = gameState === 'FUT' ? (rawGame.ticketsLink ?? '') : '';
  const gameCenter = rawGame.gameCenterLink ?? '';
  const isPlayoff = rawGame.gameType === 3;
  const isPreseason = rawGame.gameType === 1;
  const periodType = rawGame.periodDescriptor?.periodType ?? null;

  const series = rawGame.seriesStatus;
  const playoffRound = isPlayoff ? derivePlayoffRound(rawGame) : null;
  const topSeedTeamAbbrev = isPlayoff
    ? (series?.topSeedTeamAbbrev ?? null)
    : null;
  const bottomSeedTeamAbbrev = isPlayoff
    ? (series?.bottomSeedTeamAbbrev ?? null)
    : null;
  const seriesWins = (() => {
    if (!isPlayoff) return null;
    const top = series?.topSeedWins;
    const bot = series?.bottomSeedWins;
    return top != null && bot != null ? `${top}-${bot}` : null;
  })();

  return /** @type {ScheduleGameContract} */ ({
    gameId,
    date,
    gameTime,
    dayOfWeek,
    venue,
    homeTeam,
    homeLogo,
    homeScore,
    awayTeam,
    awayLogo,
    awayScore,
    broadcasts,
    ticketLink,
    gameCenter,
    isPlayoff,
    isPreseason,
    playoffRound,
    periodType,
    seriesWins,
    topSeedTeamAbbrev,
    bottomSeedTeamAbbrev,
    gameState,
  });
}

module.exports = { mapGame, mapBroadcasts, derivePlayoffRound };
