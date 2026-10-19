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

test('tasks run one at a time, fire-and-forget, and a failure does not stall the queue', async () => {
  const events = [];
  assert.equal(
    runServiceTask('a', async () => {
      events.push('a-start');
      await delay(20);
      events.push('a-end');
    }),
    null,
  );
  runServiceTask('boom', async () => {
    events.push('boom');
    throw new Error('kaboom');
  });
  runServiceTask('b', async () => {
    events.push('b-start');
    await delay(5);
    events.push('b-end');
  });

  await whenIdle();
  // No interleaving, and the failing task is followed by the next one.
  assert.deepEqual(events, ['a-start', 'a-end', 'boom', 'b-start', 'b-end']);
});

test('a duplicate label is skipped while in flight but may run again afterwards', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await delay(10);
  };
  runServiceTask('dupe', fn);
  runServiceTask('dupe', fn); // same label, still in flight -> skipped
  await whenIdle();
  assert.equal(calls, 1);

  runServiceTask('dupe', fn);
  await whenIdle();
  assert.equal(calls, 2);
});
