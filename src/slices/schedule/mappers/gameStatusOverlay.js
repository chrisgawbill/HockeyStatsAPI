/**
 * gameStatusOverlay
 *
 * The season schedule is cached for hours, so a game in it can still read
 * FUT or LIVE after a fresher payload we already hold (a gamecenter boxscore or
 * landing, a club's current week) shows it live or final. These helpers pick
 * the most advanced status among those payloads and apply it to a
 * ScheduleGameContract. A game's state only moves forward, so the furthest
 * along wins.
 */

/** How far along each NHL game state is; unknown states rank below all. */
const GAME_STATE_PROGRESS = {
  FUT: 0,
  PRE: 1,
  LIVE: 2,
  CRIT: 2,
  FINAL: 3,
  OFF: 4,
};

/**
 * @typedef {Object} GameStatus
 * @property {string}      gameState
 * @property {number|null} homeScore
 * @property {number|null} awayScore
 * @property {string|null} periodType
 */

/** Progress rank of a game state; -1 for missing or unknown states. */
function rankGameState(gameState) {
  return GAME_STATE_PROGRESS[gameState] ?? -1;
}

/** True once a game has its official final (`OFF`), after which nothing changes. */
function isOfficialFinal(gameState) {
  return gameState === 'OFF';
}

/**
 * The status fields of a raw NHL game. Gamecenter payloads and club-schedule
 * games share these fields, so one reader serves both. Null when absent.
 * @returns {GameStatus|null}
 */
function readRawGameStatus(rawGame) {
  if (!rawGame?.gameState) return null;
  return {
    gameState: rawGame.gameState,
    homeScore: rawGame.homeTeam?.score ?? null,
    awayScore: rawGame.awayTeam?.score ?? null,
    periodType: rawGame.periodDescriptor?.periodType ?? null,
  };
}

/** Goals scored so far, used to prefer the later of two live payloads. */
function countGoals(status) {
  return (status.homeScore ?? 0) + (status.awayScore ?? 0);
}

/** True when `candidate` is further along than `current`. */
function isNewerStatus(candidate, current) {
  const candidateRank = rankGameState(candidate.gameState);
  const currentRank = rankGameState(current.gameState);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  return countGoals(candidate) > countGoals(current);
}

/**
 * Returns `game` with the newest status among `statuses` applied, or `game`
 * itself when none is newer. Leaving FUT also drops the ticket link, matching
 * the schedule mapper.
 * @param {import('./scheduleMapper.js').ScheduleGameContract} game
 * @param {(GameStatus|null)[]} statuses
 */
function applyNewestGameStatus(game, statuses) {
  const newestStatus = statuses.reduce(
    (newest, status) =>
      status && isNewerStatus(status, newest) ? status : newest,
    game,
  );
  if (newestStatus === game) return game;
  return {
    ...game,
    gameState: newestStatus.gameState,
    homeScore: newestStatus.homeScore ?? game.homeScore,
    awayScore: newestStatus.awayScore ?? game.awayScore,
    periodType: newestStatus.periodType ?? game.periodType,
    ticketLink: newestStatus.gameState === 'FUT' ? game.ticketLink : '',
  };
}

module.exports = {
  applyNewestGameStatus,
  isOfficialFinal,
  readRawGameStatus,
};
