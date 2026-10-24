const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createStore } = require('../src/store.js');
const { createDeliveryWorker, classifyPushFailure } = require('../src/deliveryWorker.js');

const START = Date.parse('2026-10-24T12:00:00Z');
const APP = {
  id: 'demo',
  token: 'demo-token-0123456789',
  vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:test@example.com' },
  events: { url: 'http://127.0.0.1:1/events', token: 'event-token-0123456789' },
  schedules: [],
};
const silentLog = { log() {}, error() {} };

function pushError(statusCode, headers = {}) {
  return Object.assign(new Error(`push ${statusCode}`), { statusCode, headers });
}

function message(overrides = {}) {
  return {
    subscription: {
      endpoint: 'https://push.example.com/send/one',
      keys: { p256dh: 'p', auth: 'a' },
    },
    payload: JSON.stringify({ title: 'Hello' }),
    ttlSeconds: 3600,
    urgency: 'normal',
    ...overrides,
  };
}

/** A store, a worker with scripted push results, and a controllable clock. */
function setup({ pushResults = [], eventResponses = [] } = {}) {
  const clock = { now: START };
  const store = createStore(':memory:');
  const sends = [];
  const eventCalls = [];
  const webPush = {
    async sendNotification(subscription, payload, options) {
      sends.push({ subscription, payload, options });
      const result = pushResults.shift();
      if (result) throw result;
    },
  };
  const fetchImpl = async (url, init) => {
    eventCalls.push({ url, init });
    const status = eventResponses.shift() ?? 204;
    return new Response(status === 204 ? null : 'nope', { status });
  };
  const worker = createDeliveryWorker({
    store,
    apps: [APP],
    webPush,
    fetchImpl,
    now: () => clock.now,
    log: silentLog,
  });
  const statusOf = (id) => store.getMessage(APP.id, id);
  return { clock, store, worker, sends, eventCalls, statusOf };
}

test('delivers a queued message with the remaining TTL and the app VAPID keys', async () => {
  const { clock, store, worker, sends, statusOf } = setup();
  const [id] = store.enqueueMessages(APP.id, [message({ topic: 'game-9' })], clock.now);
  clock.now += 600 * 1000;

  await worker.runOnce();

  assert.equal(statusOf(id).status, 'delivered');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].options.TTL, 3000);
  assert.equal(sends[0].options.topic, 'game-9');
  assert.deepEqual(sends[0].options.vapidDetails, APP.vapid);
  assert.equal(sends[0].subscription.endpoint, 'https://push.example.com/send/one');
});

test('retries transient failures with backoff, then delivers', async () => {
  const { clock, store, worker, sends, statusOf } = setup({
    pushResults: [pushError(503), pushError(429, { 'retry-after': '120' }), new Error('socket hang up')],
  });
  const [id] = store.enqueueMessages(APP.id, [message()], clock.now);

  await worker.runOnce();
  assert.equal(statusOf(id).status, 'queued');
  assert.equal(statusOf(id).attempts, 1);

  // Not due again until the backoff passes.
  await worker.runOnce();
  assert.equal(sends.length, 1);

  clock.now += 20 * 1000;
  await worker.runOnce();
  assert.equal(sends.length, 2);

  // Retry-After of 120s is honoured.
  clock.now += 60 * 1000;
  await worker.runOnce();
  assert.equal(sends.length, 2);
  clock.now += 61 * 1000;
  await worker.runOnce();
  assert.equal(sends.length, 3);
  assert.match(statusOf(id).last_error, /socket hang up/);

  clock.now += 2 * 60 * 1000;
  await worker.runOnce();
  assert.equal(statusOf(id).status, 'delivered');
  assert.equal(statusOf(id).attempts, 4);
});

test('expires a message whose TTL runs out while retrying', async () => {
  const { clock, store, worker, statusOf } = setup({
    pushResults: Array.from({ length: 20 }, () => pushError(500)),
  });
  const [id] = store.enqueueMessages(APP.id, [message({ ttlSeconds: 60 })], clock.now);
  for (let pass = 0; pass < 5; pass += 1) {
    await worker.runOnce();
    clock.now += 30 * 1000;
  }
  assert.equal(statusOf(id).status, 'expired');
});

test('a gone subscription is reported to the app webhook, retrying until it answers', async () => {
  const { clock, store, worker, eventCalls, statusOf } = setup({
    pushResults: [pushError(410)],
    eventResponses: [502, 204],
  });
  const [id] = store.enqueueMessages(APP.id, [message()], clock.now);

  await worker.runOnce();
  assert.equal(statusOf(id).status, 'gone');
  assert.equal(eventCalls.length, 1);
  assert.equal(eventCalls[0].url, APP.events.url);
  assert.equal(eventCalls[0].init.headers.Authorization, `Bearer ${APP.events.token}`);
  assert.deepEqual(JSON.parse(eventCalls[0].init.body), {
    type: 'subscription.gone',
    endpoint: 'https://push.example.com/send/one',
    messageId: id,
  });
  assert.equal(store.getBacklog().pending_events, 1);

  clock.now += 20 * 1000;
  await worker.runOnce();
  assert.equal(eventCalls.length, 2);
  assert.equal(store.getBacklog().pending_events, 0);
});

test('other 4xx responses fail without retrying', async () => {
  const { clock, store, worker, sends, statusOf } = setup({ pushResults: [pushError(413)] });
  const [id] = store.enqueueMessages(APP.id, [message()], clock.now);
  await worker.runOnce();
  clock.now += 60 * 60 * 1000;
  await worker.runOnce();
  assert.equal(statusOf(id).status, 'failed');
  assert.equal(sends.length, 1);
});

test('enqueueing the same dedupe key twice returns the original message', () => {
  const { clock, store } = setup();
  const [firstId] = store.enqueueMessages(APP.id, [message({ dedupeKey: 'aar-9:u7:s1' })], clock.now);
  const [againId, otherId] = store.enqueueMessages(
    APP.id,
    [message({ dedupeKey: 'aar-9:u7:s1' }), message({ dedupeKey: 'aar-9:u7:s2' })],
    clock.now,
  );
  assert.equal(againId, firstId);
  assert.notEqual(otherId, firstId);
  assert.equal(store.getBacklog().queued_messages, 2);
});

test('classifies push failures', () => {
  assert.equal(classifyPushFailure(pushError(404)), 'gone');
  assert.equal(classifyPushFailure(pushError(410)), 'gone');
  assert.equal(classifyPushFailure(pushError(429)), 'retry');
  assert.equal(classifyPushFailure(pushError(502)), 'retry');
  assert.equal(classifyPushFailure(new Error('ETIMEDOUT')), 'retry');
  assert.equal(classifyPushFailure(pushError(400)), 'reject');
  assert.equal(classifyPushFailure(pushError(403)), 'reject');
});
