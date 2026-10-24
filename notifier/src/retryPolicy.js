const BASE_DELAY_MS = 15 * 1000;
const MAX_DELAY_MS = 30 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** Delay before the next try after `attempts` failures: doubling from 15s, capped at 30 min, with ±20% jitter. */
function retryDelayMs(attempts, { retryAfterMs = 0, random = Math.random } = {}) {
  const exponentialDelay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
  const jitteredDelay = exponentialDelay * (0.8 + random() * 0.4);
  return Math.round(Math.max(jitteredDelay, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)));
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds; 0 when absent or invalid. */
function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (!headerValue) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryAtMs = Date.parse(headerValue);
  return Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - now) : 0;
}

/** True for HTTP statuses worth retrying: timeouts, rate limits and server errors. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

module.exports = { retryDelayMs, parseRetryAfterMs, isRetryableStatus };
