#!/usr/bin/env node
/**
 * GitHub Actions entry point for After Action Report pushes. Checks the public
 * NHL scoreboard first and calls the API's dispatch route only when a game is
 * live or recently final, so the hosted API/database stay asleep otherwise.
 *
 * Env: CRON_SECRET, AAR_PUSH_API_URL.
 */
const RECENT_FINAL_MS = 4.5 * 60 * 60 * 1000;
const DISPATCH_TIMEOUT_MS = 120 * 1000;
const SCORE_TIMEOUT_MS = 15 * 1000;
const LIVE_STATES = new Set(['LIVE', 'CRIT']);
const FINAL_STATES = new Set(['FINAL', 'OFF']);

/** True when a game is in progress or went final within the last 4.5 hours. */
function shouldDispatch(games, now = Date.now()) {
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

/** Formats an epoch-millisecond timestamp as a UTC YYYY-MM-DD date. */
function formatUtcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fetches the NHL scoreboard games for a UTC date. */
async function fetchGames(date) {
  const response = await fetch(`https://api-web.nhle.com/v1/score/${date}`, {
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`score ${date} responded ${response.status}`);
  const scoreboard = await response.json();
  return scoreboard.games ?? [];
}

/** POSTs to the dispatch route, retrying once on network errors and 5xx responses. */
async function callDispatch(baseUrl, secret) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/push/dispatch`;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      if (response.status >= 500) {
        lastError = new Error(`dispatch responded ${response.status}`);
        console.error(`Attempt ${attempt}: ${lastError.message}`);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`dispatch responded ${response.status}: ${text}`);
      }
      return JSON.parse(text);
    } catch (error) {
      if (error.message.startsWith('dispatch responded')) throw error;
      lastError = error;
      console.error(`Attempt ${attempt}: ${error.message}`);
    }
  }
  throw lastError;
}

/** Decides from the scoreboard whether to dispatch, then calls the API. */
async function main() {
  const secret = process.env.CRON_SECRET;
  const apiUrl = process.env.AAR_PUSH_API_URL;
  if (!secret || !apiUrl) {
    console.error(
      'Missing CRON_SECRET or AAR_PUSH_API_URL. Add both as GitHub repository secrets.',
    );
    process.exit(1);
  }

  const now = Date.now();
  const scoreboardResults = await Promise.allSettled([
    fetchGames(formatUtcDate(now)),
    fetchGames(formatUtcDate(now - 24 * 60 * 60 * 1000)),
  ]);
  if (scoreboardResults.every(({ status }) => status === 'rejected')) {
    console.warn('Scoreboard unavailable; dispatching anyway.');
  } else {
    const games = scoreboardResults.flatMap(({ status, value }) =>
      status === 'fulfilled' ? value : [],
    );
    if (!shouldDispatch(games, now)) {
      console.log('No live or recently final games; skipping dispatch.');
      return;
    }
  }

  const dispatchSummary = await callDispatch(apiUrl, secret);
  console.log(JSON.stringify(dispatchSummary));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Dispatch failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { shouldDispatch };
