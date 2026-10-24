/**
 * Client for the notifier service (see notifier/README.md), which queues Web
 * Push messages and retries them until they are delivered or expire. Used
 * instead of sending directly when NOTIFIER_URL and NOTIFIER_TOKEN are set.
 */
const ENQUEUE_TIMEOUT_MS = 10 * 1000;

/** Reads the notifier URL and token from the environment, or null when unset. */
function readNotifierConfig() {
  const url = process.env.NOTIFIER_URL;
  const token = process.env.NOTIFIER_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * Hands messages to the notifier; resolves once they are stored there and
 * throws on any failure. Each dedupe key makes a retried enqueue harmless.
 */
async function enqueueMessages(notifierConfig, messages) {
  const response = await fetch(`${notifierConfig.url}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notifierConfig.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(ENQUEUE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `notifier responded ${response.status}: ${await response.text()}`,
    );
  }
}

module.exports = { readNotifierConfig, enqueueMessages };
