const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');

// Ensure the guard clauses pass before requiring the module (env is read at
// call time, but set it up front so intent is clear).
process.env.CACHE_DATABASE_URL =
  process.env.CACHE_DATABASE_URL || 'postgres://test/db';
delete process.env.DISABLE_DOMAIN_PERSISTENCE;

const { runServiceTask, whenIdle } = require('#platform/runServiceTask.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let originalError;
beforeEach(() => {
  originalError = console.error;
  console.error = () => {}; // silence expected task-failure logs
});
afterEach(() => {
  console.error = originalError;
});

test('runServiceTask returns null (fire-and-forget contract)', async () => {
  assert.equal(
    runServiceTask('fire-forget', () => Promise.resolve()),
    null,
  );
  await whenIdle();
});

test('tasks run one at a time (concurrency 1)', async () => {
  const events = [];
  runServiceTask('a', async () => {
    events.push('a-start');
    await delay(20);
    events.push('a-end');
  });
  runServiceTask('b', async () => {
    events.push('b-start');
    await delay(5);
    events.push('b-end');
  });

  await whenIdle();
  // b must not start until a has finished — no interleaving.
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('a duplicate label is skipped while one is queued/running', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await delay(10);
  };
  runServiceTask('dupe', fn);
  runServiceTask('dupe', fn); // same label, still in-flight → skipped

  await whenIdle();
  assert.equal(calls, 1);
});

test('the same label may run again after it completes', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
  };
  runServiceTask('reuse', fn);
  await whenIdle();
  runServiceTask('reuse', fn);
  await whenIdle();
  assert.equal(calls, 2);
});

test('a failing task does not stall the queue', async () => {
  const events = [];
  runServiceTask('boom', async () => {
    events.push('boom');
    throw new Error('kaboom');
  });
  runServiceTask('after', async () => {
    events.push('after');
  });

  await whenIdle();
  assert.deepEqual(events, ['boom', 'after']);
});
