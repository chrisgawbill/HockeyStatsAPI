/**
 * Cheap gate for After Action Report dispatch: the public NHL scoreboard says
 * whether any game is live or went final recently, so the scheduled dispatch
 * skips the per-team schedule refreshes the rest of the day.
 */
const RECENT_FINAL_MS = 4.5 * 60 * 60 * 1000;
const SCORE_TIMEOUT_MS = 15 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATES = new Set(['LIVE', 'CRIT']);
const FINAL_STATES = new Set(['FINAL', 'OFF']);

/** True when a game is in progress or went final within the last 4.5 hours. */
function hasActiveGames(games, now = Date.now()) {
  return (games ?? []).some((game) => {
    if (LIVE_STATES.has(game.gameState)) return true;
    if (!FINAL_STATES.has(game.gameState)) return false;
    const startMs = Date.parse(game.startTimeUTC);
    return (
      Number.isFinite(startMs) &&
      now - startMs >= 0 &&
      now - startMs <= RECENT_FINAL_MS
    );
  });
}

/** Fetches the NHL scoreboard games for a UTC date (YYYY-MM-DD). */
async function fetchScoreboardGames(date) {
  const response = await fetch(`https://api-web.nhle.com/v1/score/${date}`, {
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`score ${date} responded ${response.status}`);
  }
  const scoreboard = await response.json();
  return scoreboard.games ?? [];
}

/**
 * Today's and yesterday's (UTC) scoreboard games, or null when the scoreboard
 * cannot be reached at all.
 */
async function listRecentScoreboardGames(now = Date.now()) {
  const dates = [now, now - DAY_MS].map((ms) =>
    new Date(ms).toISOString().slice(0, 10),
  );
  const scoreboardResults = await Promise.allSettled(
    dates.map(fetchScoreboardGames),
  );
  if (scoreboardResults.every(({ status }) => status === 'rejected')) {
    return null;
  }
  return scoreboardResults.flatMap(({ status, value }) =>
    status === 'fulfilled' ? value : [],
  );
}

module.exports = { hasActiveGames, listRecentScoreboardGames };
