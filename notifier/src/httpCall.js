const { parseRetryAfterMs } = require('./retryPolicy.js');

const MAX_RESPONSE_TEXT = 2000;

/**
 * Makes one HTTP request with an optional bearer token and JSON body.
 * Resolves to `{ status, text, retryAfterMs }` for any HTTP response and
 * rejects only on network errors or the timeout.
 */
async function callHttp(fetchImpl, { url, method = 'POST', token, body, timeoutMs }) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = (await response.text()).slice(0, MAX_RESPONSE_TEXT);
  return {
    status: response.status,
    text,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
  };
}

module.exports = { callHttp };
