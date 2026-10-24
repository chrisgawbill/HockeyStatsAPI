const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createStore } = require('../src/store.js');
const { createScheduler, validateSchedules } = require('../src/scheduler.js');
const { parseConfig } = require('../src/config.js');

const silentLog = { log() {}, error() {} };

function weeklyApp(scheduleOverrides = {}) {
  return {
    id: 'demo',
    token: 'demo-token-0123456789',
    vapid: null,
    events: null,
    schedules: [
      {
        id: 'weekly',
        cron: '0 9 * * 1',
        timezone: 'America/New_York',
        url: 'http://127.0.0.1:9000/weekly',
        method: 'POST',
        token: 'cron-secret-0123456789',
        body: null,
        timeoutMs: 1000,
        retries: 2,
        catchUp: true,
        ...scheduleOverrides,
      },
    ],
  };
}

/** A scheduler whose HTTP calls answer with the scripted statuses (an Error means a network failure). */
function setup({ responses = [], nowMs, app = weeklyApp() }) {
  const store = createStore(':memory:');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift() ?? 200;
    if (response instanceof Error) throw response;
    return new Response('{"sent":1}', { status: response });
  };
  const scheduler = createScheduler({
    store,
    apps: [app],
    fetchImpl,
    now: () => nowMs,
    wait: async () => {},
    log: silentLog,
  });
  return { store, scheduler, calls, app };
}

test('a run calls the URL with the bearer token and records the outcome', async () => {
  const { scheduler, calls, store } = setup({ nowMs: Date.parse('2026-10-26T13:00:00Z') });
  const runOutcome = await scheduler.runNow('demo', 'weekly');
  assert.deepEqual(runOutcome, { outcome: 'ok', httpStatus: 200, detail: '{"sent":1}' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cron-secret-0123456789');
  assert.equal(store.getLatestRun('demo', 'weekly').outcome, 'ok');
  assert.equal(await scheduler.runNow('demo', 'missing'), null);
});

test('a run retries network errors and 5xx but not other 4xx', async () => {
  const retried = setup({ responses: [new Error('ECONNREFUSED'), 503, 200], nowMs: 0 });
  assert.equal((await retried.scheduler.runNow('demo', 'weekly')).outcome, 'ok');
  assert.equal(retried.calls.length, 3);

  const exhausted = setup({ responses: [502, 502, 502, 200], nowMs: 0 });
  assert.equal((await exhausted.scheduler.runNow('demo', 'weekly')).httpStatus, 502);
  assert.equal(exhausted.calls.length, 3);

  const rejected = setup({ responses: [401], nowMs: 0 });
  assert.equal((await rejected.scheduler.runNow('demo', 'weekly')).outcome, 'failed');
  assert.equal(rejected.calls.length, 1);
});

test('a catch-up schedule runs at startup only when its last scheduled time was missed', async () => {
  // Last run the previous Monday; it is now Monday 11:00 ET, after the missed 9:00 run.
  const missed = setup({ nowMs: Date.parse('2026-10-26T15:00:00Z') });
  missed.store.startRun('demo', 'weekly', Date.parse('2026-10-19T13:00:00Z'));
  missed.scheduler.start();
  missed.scheduler.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(missed.calls.length, 1);

  // Already ran today at 9:00 ET.
  const onTime = setup({ nowMs: Date.parse('2026-10-26T15:00:00Z') });
  onTime.store.startRun('demo', 'weekly', Date.parse('2026-10-26T13:00:00Z'));
  onTime.scheduler.start();
  onTime.scheduler.stop();
  assert.equal(onTime.calls.length, 0);

  // A fresh install has no history and does not catch up.
  const fresh = setup({ nowMs: Date.parse('2026-10-26T15:00:00Z') });
  fresh.scheduler.start();
  fresh.scheduler.stop();
  assert.equal(fresh.calls.length, 0);
});

test('invalid cron patterns and time zones fail validation', () => {
  assert.doesNotThrow(() => validateSchedules([weeklyApp()]));
  assert.throws(() => validateSchedules([weeklyApp({ cron: 'not a cron' })]), /demo\/weekly/);
  assert.throws(() => validateSchedules([weeklyApp({ timezone: 'Mars/Olympus' })]), /demo\/weekly/);
});

test('config resolves env references, fills defaults and rejects weak secrets', () => {
  const rawConfig = {
    apps: [
      {
        id: 'demo',
        token: 'env:DEMO_TOKEN',
        events: { url: 'http://127.0.0.1:9000/events', token: 'env:DEMO_EVENTS' },
        schedules: [{ id: 'tick', cron: '*/5 * * * *', url: 'http://127.0.0.1:9000/tick' }],
      },
    ],
  };
  const env = { DEMO_TOKEN: 'a'.repeat(32), DEMO_EVENTS: 'b'.repeat(32) };
  const config = parseConfig(rawConfig, { env, baseDir: '/srv/notifier' });
  assert.equal(config.apps[0].token, 'a'.repeat(32));
  assert.equal(config.apps[0].events.token, 'b'.repeat(32));
  assert.equal(config.port, 9100);
  assert.equal(config.databasePath, '/srv/notifier/notifier.db');
  assert.deepEqual(
    { ...config.apps[0].schedules[0] },
    {
      id: 'tick',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      url: 'http://127.0.0.1:9000/tick',
      method: 'POST',
      token: null,
      body: null,
      timeoutMs: 120000,
      retries: 2,
      catchUp: false,
    },
  );
  assert.throws(() => parseConfig(rawConfig, { env: {} }), /unset DEMO_TOKEN/);
  assert.throws(
    () => parseConfig(rawConfig, { env: { ...env, DEMO_TOKEN: 'short' } }),
    /at least 16/,
  );
});
