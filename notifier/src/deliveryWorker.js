const { callHttp } = require('./httpCall.js');
const {
  retryDelayMs,
  parseRetryAfterMs,
  isRetryableStatus,
} = require('./retryPolicy.js');

const MAX_PUSH_ATTEMPTS = 10;
const PUSH_TIMEOUT_MS = 15 * 1000;
const EVENT_TIMEOUT_MS = 15 * 1000;
const EVENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;

/**
 * Sorts a web-push failure into what to do next: `gone` (the subscription no
 * longer exists), `retry` (rate limit, push service error, network or
 * timeout) or `reject` (any other 4xx: retrying cannot help).
 */
function classifyPushFailure(error) {
  const status = error?.statusCode;
  if (status === 404 || status === 410) return 'gone';
  if (!status || isRetryableStatus(status)) return 'retry';
  return 'reject';
}

/** Describes a web-push failure for the message's last_error. */
function describePushFailure(error) {
  const status = error?.statusCode ? `${error.statusCode} ` : '';
  const body = error?.body ? `: ${error.body}` : '';
  return `${status}${error?.message ?? error}${body}`;
}

/**
 * Background loop that drains the queue: sends due push messages with the
 * owning app's VAPID keys and retries transient failures with backoff until
 * the message's TTL runs out, then delivers app events (subscription gone)
 * to each app's webhook, also with retries.
 */
function createDeliveryWorker({
  store,
  apps,
  webPush = require('web-push'),
  fetchImpl = fetch,
  now = () => Date.now(),
  log = console,
}) {
  const appsById = new Map(apps.map((app) => [app.id, app]));
  let isRunning = false;
  let timer = null;
  let isStopped = true;

  /** Sends one message; resolves on success and rejects with the web-push error. */
  async function sendPush(message, app) {
    const secondsLeft = Math.max(0, Math.floor((message.expires_at - now()) / 1000));
    await webPush.sendNotification(
      {
        endpoint: message.endpoint,
        keys: { p256dh: message.p256dh, auth: message.auth },
      },
      message.payload,
      {
        TTL: secondsLeft,
        urgency: message.urgency,
        ...(message.topic ? { topic: message.topic } : {}),
        timeout: PUSH_TIMEOUT_MS,
        vapidDetails: app.vapid,
      },
    );
  }

  /** Tells the app its subscription is gone so it can delete it. */
  function reportGoneSubscription(message, app) {
    if (!app.events) return;
    const queuedAt = now();
    store.enqueueEvent(
      app.id,
      {
        type: 'subscription.gone',
        endpoint: message.endpoint,
        messageId: message.id,
      },
      { now: queuedAt, expiresAt: queuedAt + EVENT_LIFETIME_MS },
    );
  }

  /** Reschedules a failed message, or marks it expired once retries or its TTL run out. */
  function scheduleRetry(message, lastError, retryAfterMs) {
    const attempts = message.attempts + 1;
    const nextAttemptAt = now() + retryDelayMs(attempts, { retryAfterMs });
    const isOutOfTime =
      attempts >= MAX_PUSH_ATTEMPTS || nextAttemptAt >= message.expires_at;
    store.updateMessage(
      {
        id: message.id,
        status: isOutOfTime ? 'expired' : 'queued',
        attempts,
        nextAttemptAt,
        lastError,
      },
      now(),
    );
    if (isOutOfTime) {
      log.error(`Push ${message.id} (${message.app_id}) expired after ${attempts} attempts: ${lastError}`);
    }
  }

  /** Attempts one due message and records the outcome. */
  async function deliverMessage(message) {
    const app = appsById.get(message.app_id);
    const finish = (status, lastError = null) =>
      store.updateMessage(
        {
          id: message.id,
          status,
          attempts: message.attempts + 1,
          nextAttemptAt: message.next_attempt_at,
          lastError,
        },
        now(),
      );
    if (!app?.vapid) {
      finish('failed', 'App has no VAPID keys configured.');
      return;
    }
    if (message.expires_at <= now()) {
      finish('expired', message.last_error);
      return;
    }
    try {
      await sendPush(message, app);
      finish('delivered');
    } catch (error) {
      const failure = classifyPushFailure(error);
      const lastError = describePushFailure(error);
      if (failure === 'gone') {
        finish('gone', lastError);
        reportGoneSubscription(message, app);
      } else if (failure === 'reject') {
        finish('failed', lastError);
        log.error(`Push ${message.id} (${message.app_id}) rejected: ${lastError}`);
      } else {
        scheduleRetry(message, lastError, parseRetryAfterMs(error?.headers?.['retry-after'], now()));
      }
    }
  }

  /** Posts one due event to its app's webhook and records the outcome. */
  async function deliverEvent(event) {
    const app = appsById.get(event.app_id);
    const attempts = event.attempts + 1;
    const record = (status, lastError, nextAttemptAt = event.next_attempt_at) =>
      store.updateEvent({ id: event.id, status, attempts, nextAttemptAt, lastError }, now());
    if (!app?.events) {
      record('failed', 'App has no events webhook configured.');
      return;
    }
    let lastError;
    let retryAfterMs = 0;
    try {
      const response = await callHttp(fetchImpl, {
        url: app.events.url,
        token: app.events.token,
        body: JSON.parse(event.body),
        timeoutMs: EVENT_TIMEOUT_MS,
      });
      if (response.status >= 200 && response.status < 300) {
        record('delivered', null);
        return;
      }
      lastError = `${response.status}: ${response.text}`;
      if (!isRetryableStatus(response.status)) {
        record('failed', lastError);
        log.error(`Event ${event.id} (${event.app_id}) rejected: ${lastError}`);
        return;
      }
      retryAfterMs = response.retryAfterMs;
    } catch (error) {
      lastError = error.message;
    }
    const nextAttemptAt = now() + retryDelayMs(attempts, { retryAfterMs });
    const isOutOfTime = nextAttemptAt >= event.expires_at;
    record(isOutOfTime ? 'failed' : 'pending', lastError, nextAttemptAt);
    if (isOutOfTime) log.error(`Event ${event.id} (${event.app_id}) gave up: ${lastError}`);
  }

  /** Works through everything currently due; returns how many rows it handled. */
  async function runOnce() {
    if (isRunning) return 0;
    isRunning = true;
    try {
      const dueMessages = store.listDueMessages(now());
      for (const message of dueMessages) await deliverMessage(message);
      const dueEvents = store.listDueEvents(now());
      for (const event of dueEvents) await deliverEvent(event);
      return dueMessages.length + dueEvents.length;
    } finally {
      isRunning = false;
    }
  }

  /** Runs the loop: polls quickly while there is work, slowly when idle. */
  async function tick() {
    let handledCount = 0;
    try {
      handledCount = await runOnce();
    } catch (error) {
      log.error('Delivery loop failed:', error);
    }
    if (!isStopped) {
      timer = setTimeout(tick, handledCount > 0 ? BUSY_POLL_MS : IDLE_POLL_MS);
    }
  }

  return {
    runOnce,

    start() {
      isStopped = false;
      tick();
    },

    /** Starts a pass now instead of waiting for the next poll (after an enqueue). */
    wake() {
      if (isStopped || isRunning) return;
      clearTimeout(timer);
      tick();
    },

    stop() {
      isStopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { createDeliveryWorker, classifyPushFailure };
