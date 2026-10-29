const axios = require('axios');

/**
 * HockeyTech feed client for AHL data. The feed is undocumented; the key is
 * the one the AHL website uses (`AHL_FEED_KEY`), so it can change or be
 * blocked without notice. Callers catch failures and keep serving cached data.
 */
const axiosAhl = axios.create({
  baseURL: 'https://lscluster.hockeytech.com/feed/',
  timeout: 15000,
});

/** Feed parameters every request needs; throws when the key is not configured. */
function getFeedParams() {
  const key = process.env.AHL_FEED_KEY;
  if (!key) throw new Error('AHL_FEED_KEY is not set.');
  return {
    key,
    client_code: process.env.AHL_CLIENT_CODE || 'ahl',
    fmt: 'json',
    lang: 'en',
  };
}

/** True when the AHL feed key is configured. */
function isAhlFeedConfigured() {
  return Boolean(process.env.AHL_FEED_KEY);
}

/** Parses a statviewfeed body, which comes wrapped in parentheses even with fmt=json. */
function parseStatviewBody(body) {
  if (typeof body !== 'string') return body;
  return JSON.parse(body.trim().replace(/^\(/, '').replace(/\)$/, ''));
}

/** Raw `SiteKit` payload of one modulekit view (seasons, teamsbyseason, schedule, roster, statviewtype). */
async function fetchModulekit(view, params = {}) {
  const response = await axiosAhl.get('', {
    params: { ...getFeedParams(), feed: 'modulekit', view, ...params },
  });
  if (!response.data?.SiteKit) {
    throw new Error(`AHL modulekit ${view} returned no SiteKit payload.`);
  }
  return response.data.SiteKit;
}

/**
 * Raw payload of one statviewfeed view (league-wide player stat tables): the
 * single `{ sections }` object the feed wraps in an array. Unwrapped because
 * pg would send a top-level array as a Postgres array, not JSON.
 */
async function fetchStatview(view, params = {}) {
  const response = await axiosAhl.get('', {
    params: { ...getFeedParams(), feed: 'statviewfeed', view, ...params },
    responseType: 'text',
  });
  const [statTable] = parseStatviewBody(response.data);
  if (!statTable?.sections) {
    throw new Error(`AHL statviewfeed ${view} returned no stat table.`);
  }
  return statTable;
}

module.exports = {
  isAhlFeedConfigured,
  parseStatviewBody,
  fetchModulekit,
  fetchStatview,
};
