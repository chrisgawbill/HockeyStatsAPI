const crypto = require('crypto');
const express = require('express');

const MAX_MESSAGES_PER_REQUEST = 500;
const MAX_PAYLOAD_BYTES = 4000;
const MAX_FIELD_LENGTH = 2048;
const MAX_DEDUPE_KEY_LENGTH = 200;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** An error that the error handler turns into a JSON response with `status`. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Length-safe constant-time string comparison. */
function secretsMatch(candidate, expected) {
  const digest = (text) => crypto.createHash('sha256').update(String(text)).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

/** True for a non-empty string no longer than `maxLength`. */
function isShortString(value, maxLength = MAX_FIELD_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** True when `endpoint` is an https URL. */
function isHttpsUrl(endpoint) {
  try {
    return new URL(endpoint).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates one requested message and fills its defaults; throws 400 naming the bad field. */
function parseMessage(message, index) {
  const fail = (field) => {
    throw httpError(400, `messages[${index}].${field} is invalid.`);
  };
  const { subscription, payload, ttlSeconds = DEFAULT_TTL_SECONDS } = message ?? {};
  if (!isShortString(subscription?.endpoint) || !isHttpsUrl(subscription.endpoint)) {
    fail('subscription.endpoint');
  }
  if (!isShortString(subscription.keys?.p256dh)) fail('subscription.keys.p256dh');
  if (!isShortString(subscription.keys?.auth)) fail('subscription.keys.auth');
  const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (payloadText === undefined || Buffer.byteLength(payloadText) > MAX_PAYLOAD_BYTES) {
    fail('payload');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    fail('ttlSeconds');
  }
  const urgency = message.urgency ?? 'normal';
  if (!URGENCIES.has(urgency)) fail('urgency');
  if (message.topic != null && !TOPIC_PATTERN.test(message.topic)) fail('topic');
  if (message.dedupeKey != null && !isShortString(message.dedupeKey, MAX_DEDUPE_KEY_LENGTH)) {
    fail('dedupeKey');
  }
  return {
    subscription,
    payload: payloadText,
    ttlSeconds,
    urgency,
    topic: message.topic ?? null,
    dedupeKey: message.dedupeKey ?? null,
  };
}

/** Formats a stored message row for the status route. */
function describeMessage(messageRow) {
  return {
    id: messageRow.id,
    status: messageRow.status,
    attempts: messageRow.attempts,
    createdAt: new Date(messageRow.created_at).toISOString(),
    updatedAt: new Date(messageRow.updated_at).toISOString(),
    lastError: messageRow.last_error,
  };
}

/**
 * HTTP API. Apps authenticate with their own bearer token and can only see
 * their own messages and schedules.
 *   POST /v1/messages               { messages: [...] } -> 202 { ids }
 *   GET  /v1/messages/:id           -> { id, status, attempts, ... }
 *   POST /v1/schedules/:id/run      -> the run outcome
 *   GET  /health                    -> backlog and schedule state (no auth)
 */
function createServer({ store, apps, deliveryWorker, scheduler, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  /** Resolves the bearer token to its app; 401 otherwise. */
  function authenticateApp(req, res, next) {
    const [scheme, token] = String(req.get('authorization') || '').split(' ');
    const caller =
      scheme === 'Bearer' && token
        ? apps.find((candidate) => secretsMatch(token, candidate.token))
        : null;
    if (!caller) return next(httpError(401, 'Unauthorized'));
    req.callerApp = caller;
    next();
  }

  app.get('/health', (req, res) => {
    const backlog = store.getBacklog();
    res.send({
      ok: true,
      queuedMessages: backlog.queued_messages,
      oldestQueuedAgeSeconds:
        backlog.oldest_queued_at == null
          ? null
          : Math.round((now() - backlog.oldest_queued_at) / 1000),
      pendingEvents: backlog.pending_events,
      schedules: scheduler.describeSchedules(),
    });
  });

  app.post('/v1/messages', authenticateApp, (req, res, next) => {
    try {
      const requestedMessages = req.body?.messages;
      if (
        !Array.isArray(requestedMessages) ||
        requestedMessages.length === 0 ||
        requestedMessages.length > MAX_MESSAGES_PER_REQUEST
      ) {
        throw httpError(400, `messages must be an array of 1 to ${MAX_MESSAGES_PER_REQUEST}.`);
      }
      if (!req.callerApp.vapid) throw httpError(409, 'This app has no VAPID keys configured.');
      const messages = requestedMessages.map(parseMessage);
      const ids = store.enqueueMessages(req.callerApp.id, messages, now());
      deliveryWorker.wake();
      res.status(202).send({ ids });
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/messages/:id', authenticateApp, (req, res, next) => {
    const messageRow = store.getMessage(req.callerApp.id, Number(req.params.id));
    if (!messageRow) return next(httpError(404, 'No such message.'));
    res.send(describeMessage(messageRow));
  });

  app.post('/v1/schedules/:id/run', authenticateApp, async (req, res, next) => {
    try {
      const runOutcome = await scheduler.runNow(req.callerApp.id, req.params.id);
      if (!runOutcome) throw httpError(404, 'No such schedule.');
      res.send(runOutcome);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res, next) => next(httpError(404, 'Not found.')));
  app.use((error, req, res, next) => {
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).send({ error: status >= 500 ? 'Internal error.' : error.message });
  });

  return app;
}

module.exports = { createServer };
