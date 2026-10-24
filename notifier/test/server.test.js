const assert = require('node:assert/strict');
const { test, after } = require('node:test');

const { createStore } = require('../src/store.js');
const { createServer } = require('../src/server.js');

const DEMO = {
  id: 'demo',
  token: 'demo-token-0123456789',
  vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:test@example.com' },
  events: null,
  schedules: [],
};
const OTHER = { ...DEMO, id: 'other', token: 'other-token-0123456789' };

const store = createStore(':memory:');
let wakeCount = 0;
const scheduler = {
  describeSchedules: () => [],
  runNow: async (appId, scheduleId) =>
    appId === 'demo' && scheduleId === 'tick' ? { outcome: 'ok', httpStatus: 200 } : null,
};
const server = createServer({
  store,
  apps: [DEMO, OTHER],
  deliveryWorker: { wake: () => (wakeCount += 1) },
  scheduler,
});
const listening = new Promise((resolve) => {
  const httpServer = server.listen(0, '127.0.0.1', () => resolve(httpServer));
});
after(async () => (await listening).close());

async function call(path, { token = DEMO.token, method = 'GET', body } = {}) {
  const { port } = (await listening).address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const validMessage = {
  subscription: { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } },
  payload: { title: 'Hi' },
  dedupeKey: 'k1',
};

test('enqueues messages for the calling app and wakes the worker', async () => {
  const response = await call('/v1/messages', { method: 'POST', body: { messages: [validMessage] } });
  assert.equal(response.status, 202);
  assert.equal(response.body.ids.length, 1);
  assert.equal(wakeCount, 1);

  const status = await call(`/v1/messages/${response.body.ids[0]}`);
  assert.equal(status.body.status, 'queued');
  // Another app cannot see it.
  assert.equal((await call(`/v1/messages/${response.body.ids[0]}`, { token: OTHER.token })).status, 404);
});

test('rejects bad tokens and invalid messages', async () => {
  assert.equal((await call('/v1/messages', { token: null, method: 'POST', body: {} })).status, 401);
  assert.equal((await call('/v1/messages', { token: 'wrong', method: 'POST', body: {} })).status, 401);
  const invalid = async (overrides) =>
    call('/v1/messages', { method: 'POST', body: { messages: [{ ...validMessage, ...overrides }] } });
  assert.match((await invalid({ subscription: { endpoint: 'http://x', keys: {} } })).body.error, /endpoint/);
  assert.match((await invalid({ payload: 'x'.repeat(5000) })).body.error, /payload/);
  assert.match((await invalid({ ttlSeconds: 0 })).body.error, /ttlSeconds/);
  assert.match((await invalid({ urgency: 'urgent' })).body.error, /urgency/);
  assert.match((await invalid({ topic: 'has spaces' })).body.error, /topic/);
  assert.equal((await call('/v1/messages', { method: 'POST', body: { messages: [] } })).status, 400);
});

test('runs a schedule on request and reports health', async () => {
  assert.deepEqual((await call('/v1/schedules/tick/run', { method: 'POST' })).body, {
    outcome: 'ok',
    httpStatus: 200,
  });
  assert.equal((await call('/v1/schedules/tick/run', { method: 'POST', token: OTHER.token })).status, 404);
  const health = await call('/health', { token: null });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(typeof health.body.queuedMessages, 'number');
});
