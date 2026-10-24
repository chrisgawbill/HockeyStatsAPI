const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    app_id TEXT NOT NULL,
    dedupe_key TEXT,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    payload TEXT NOT NULL,
    urgency TEXT NOT NULL,
    topic TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT,
    UNIQUE (app_id, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS messages_due ON messages (status, next_attempt_at);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    app_id TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS events_due ON events (status, next_attempt_at);

  CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY,
    app_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT,
    http_status INTEGER,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS schedule_runs_latest
    ON schedule_runs (app_id, schedule_id, started_at);
`;

const DUE_BATCH_SIZE = 100;
const MAX_ERROR_LENGTH = 500;

/** Trims an error description so one bad response cannot bloat the database. */
function shortenError(errorText) {
  return errorText == null ? null : String(errorText).slice(0, MAX_ERROR_LENGTH);
}

/** Runs `work` inside one SQLite transaction. */
function inTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * SQLite persistence for queued push messages, outgoing app events and
 * schedule runs. Times are epoch milliseconds. The service is a single
 * process, so rows need no leases: a crash simply leaves them queued.
 */
function createStore(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertMessage = db.prepare(`
    INSERT INTO messages (app_id, dedupe_key, endpoint, p256dh, auth, payload,
      urgency, topic, next_attempt_at, expires_at, created_at, updated_at)
    VALUES (:appId, :dedupeKey, :endpoint, :p256dh, :auth, :payload,
      :urgency, :topic, :now, :expiresAt, :now, :now)
    ON CONFLICT (app_id, dedupe_key) DO UPDATE SET dedupe_key = excluded.dedupe_key
    RETURNING id
  `);
  const selectDueMessages = db.prepare(`
    SELECT * FROM messages
    WHERE status = 'queued' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, id
    LIMIT ${DUE_BATCH_SIZE}
  `);
  const updateMessage = db.prepare(`
    UPDATE messages
    SET status = :status, attempts = :attempts, next_attempt_at = :nextAttemptAt,
      last_error = :lastError, updated_at = :now
    WHERE id = :id
  `);
  const selectMessage = db.prepare(
    'SELECT id, status, attempts, created_at, updated_at, last_error FROM messages WHERE id = ? AND app_id = ?',
  );
  const insertEvent = db.prepare(`
    INSERT INTO events (app_id, body, next_attempt_at, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectDueEvents = db.prepare(`
    SELECT * FROM events
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, id
    LIMIT ${DUE_BATCH_SIZE}
  `);
  const updateEvent = db.prepare(`
    UPDATE events
    SET status = :status, attempts = :attempts, next_attempt_at = :nextAttemptAt,
      last_error = :lastError, updated_at = :now
    WHERE id = :id
  `);
  const insertRun = db.prepare(
    'INSERT INTO schedule_runs (app_id, schedule_id, started_at) VALUES (?, ?, ?) RETURNING id',
  );
  const finishRunStatement = db.prepare(`
    UPDATE schedule_runs
    SET finished_at = :finishedAt, outcome = :outcome, http_status = :httpStatus, detail = :detail
    WHERE id = :id
  `);
  const selectLatestRun = db.prepare(`
    SELECT started_at, finished_at, outcome, http_status, detail FROM schedule_runs
    WHERE app_id = ? AND schedule_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `);
  const selectBacklog = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE status = 'queued') AS queued_messages,
      (SELECT MIN(created_at) FROM messages WHERE status = 'queued') AS oldest_queued_at,
      (SELECT COUNT(*) FROM events WHERE status = 'pending') AS pending_events
  `);

  return {
    /**
     * Queues messages in one transaction and returns their ids. A message
     * whose dedupe key the app already used returns the existing id instead,
     * so an app can safely retry an enqueue.
     */
    enqueueMessages(appId, messages, now) {
      return inTransaction(db, () =>
        messages.map((message) => {
          const { id } = insertMessage.get({
            appId,
            dedupeKey: message.dedupeKey ?? null,
            endpoint: message.subscription.endpoint,
            p256dh: message.subscription.keys.p256dh,
            auth: message.subscription.keys.auth,
            payload: message.payload,
            urgency: message.urgency,
            topic: message.topic ?? null,
            expiresAt: now + message.ttlSeconds * 1000,
            now,
          });
          return id;
        }),
      );
    },

    /** Queued messages whose next attempt is due. */
    listDueMessages(now) {
      return selectDueMessages.all(now);
    },

    /** Records a message's new status, attempt count and next attempt time. */
    updateMessage({ id, status, attempts, nextAttemptAt, lastError = null }, now) {
      updateMessage.run({
        id,
        status,
        attempts,
        nextAttemptAt,
        lastError: shortenError(lastError),
        now,
      });
    },

    /** One message's delivery status, or undefined when the app does not own it. */
    getMessage(appId, id) {
      return selectMessage.get(id, appId);
    },

    /** Queues an event (a JSON body) for delivery to the app's webhook. */
    enqueueEvent(appId, body, { now, expiresAt }) {
      insertEvent.run(appId, JSON.stringify(body), now, expiresAt, now, now);
    },

    /** Pending events whose next attempt is due. */
    listDueEvents(now) {
      return selectDueEvents.all(now);
    },

    /** Records an event's new status, attempt count and next attempt time. */
    updateEvent({ id, status, attempts, nextAttemptAt, lastError = null }, now) {
      updateEvent.run({
        id,
        status,
        attempts,
        nextAttemptAt,
        lastError: shortenError(lastError),
        now,
      });
    },

    /** Records the start of a schedule run and returns its id. */
    startRun(appId, scheduleId, now) {
      return insertRun.get(appId, scheduleId, now).id;
    },

    /** Records how a schedule run ended. */
    finishRun(runId, { outcome, httpStatus = null, detail = null }, now) {
      finishRunStatement.run({
        id: runId,
        finishedAt: now,
        outcome,
        httpStatus,
        detail: shortenError(detail),
      });
    },

    /** The most recent run of a schedule, or undefined when it never ran. */
    getLatestRun(appId, scheduleId) {
      return selectLatestRun.get(appId, scheduleId);
    },

    /** Counts of work still waiting, for /health. */
    getBacklog() {
      return selectBacklog.get();
    },

    /** Deletes finished messages and events, and schedule runs, last touched before `cutoff`. */
    pruneBefore(cutoff) {
      inTransaction(db, () => {
        db.prepare("DELETE FROM messages WHERE status != 'queued' AND updated_at < ?").run(cutoff);
        db.prepare("DELETE FROM events WHERE status != 'pending' AND updated_at < ?").run(cutoff);
        db.prepare('DELETE FROM schedule_runs WHERE started_at < ?').run(cutoff);
      });
    },

    close() {
      db.close();
    },
  };
}

module.exports = { createStore };
