// Labels currently queued or running, for by-label dedupe.
const inFlightServiceTasks = new Set();

// Tail of a concurrency-1 promise queue. Background persist tasks are chained
// through this so only one runs at a time. These are fire-and-forget
// write-through tasks where contention — not throughput — is what hurts: two
// same-season tasks running at once hold overlapping transactions and time out
// on the shared `seasons` row lock (see cleanup-backlog C8). Serializing them
// is a cheap structural guard that makes that overlap impossible.
let queueTail = Promise.resolve();

/** True when a database is configured for persisting domain data. */
function isDomainPersistenceConfigured() {
  return Boolean(process.env.DATABASE_URL || process.env.CACHE_DATABASE_URL);
}

/**
 * Queues a fire-and-forget persistence task. Skips silently when persistence
 * is disabled or unconfigured, or when a task with the same label is already
 * queued or running. A failed task is logged and swallowed so it never stalls
 * the queue. Always returns null.
 */
function runServiceTask(label, serviceFn) {
  if (process.env.DISABLE_DOMAIN_PERSISTENCE === 'true') return null;
  if (!isDomainPersistenceConfigured()) return null;
  if (inFlightServiceTasks.has(label)) return null;

  inFlightServiceTasks.add(label);
  queueTail = queueTail
    .then(() => serviceFn())
    .catch((error) => {
      console.error(`Domain service task failed for ${label}:`, error);
    })
    .finally(() => inFlightServiceTasks.delete(label));

  return null;
}

/**
 * Test-only seam: resolves once the currently-queued tasks have drained. Not
 * part of the fire-and-forget contract — callers never await runServiceTask.
 */
function whenIdle() {
  return queueTail;
}

module.exports = {
  runServiceTask,
  isDomainPersistenceConfigured,
  whenIdle,
};
