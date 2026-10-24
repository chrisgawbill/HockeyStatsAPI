const { Cron } = require('croner');
const { callHttp } = require('./httpCall.js');
const { isRetryableStatus } = require('./retryPolicy.js');

const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];

/** Waits `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cron-driven HTTP jobs, the replacement for an external cron such as GitHub
 * Actions. Each app schedule calls its URL on its cron (in its own time
 * zone), retries network errors, 408/429 and 5xx a few times, and records
 * every run. A schedule marked `catchUp` runs once at startup when the
 * service was down at its last scheduled time.
 */
function createScheduler({
  store,
  apps,
  fetchImpl = fetch,
  now = () => Date.now(),
  wait = sleep,
  log = console,
}) {
  const jobs = [];
  const runningJobKeys = new Set();

  /** Calls the schedule's URL once; resolves to the run outcome. */
  async function callOnce(schedule) {
    try {
      const response = await callHttp(fetchImpl, {
        url: schedule.url,
        method: schedule.method,
        token: schedule.token,
        body: schedule.body,
        timeoutMs: schedule.timeoutMs,
      });
      const isSuccess = response.status >= 200 && response.status < 300;
      return {
        outcome: isSuccess ? 'ok' : 'failed',
        httpStatus: response.status,
        detail: response.text,
        isRetryable: !isSuccess && isRetryableStatus(response.status),
      };
    } catch (error) {
      return { outcome: 'failed', httpStatus: null, detail: error.message, isRetryable: true };
    }
  }

  /** Runs one schedule now, with retries, unless it is already running. */
  async function runSchedule(app, schedule) {
    const jobKey = `${app.id}/${schedule.id}`;
    if (runningJobKeys.has(jobKey)) {
      return { outcome: 'skipped', detail: 'Previous run still in progress.' };
    }
    runningJobKeys.add(jobKey);
    const runId = store.startRun(app.id, schedule.id, now());
    try {
      let result = await callOnce(schedule);
      for (let retry = 0; retry < schedule.retries && result.isRetryable; retry += 1) {
        log.error(`Schedule ${jobKey} attempt ${retry + 1} failed (${result.httpStatus ?? 'network'}): ${result.detail}`);
        await wait(RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]);
        result = await callOnce(schedule);
      }
      const { isRetryable, ...runOutcome } = result;
      store.finishRun(runId, runOutcome, now());
      if (runOutcome.outcome === 'ok') {
        log.log(`Schedule ${jobKey} ok: ${runOutcome.detail}`);
      } else {
        log.error(`Schedule ${jobKey} failed (${runOutcome.httpStatus ?? 'network'}): ${runOutcome.detail}`);
      }
      return runOutcome;
    } finally {
      runningJobKeys.delete(jobKey);
    }
  }

  /** True when a catch-up schedule's latest scheduled time passed while the service was down. */
  function missedLastRun(app, schedule, cron) {
    if (!schedule.catchUp) return false;
    const latestRun = store.getLatestRun(app.id, schedule.id);
    if (!latestRun) return false;
    const [lastScheduledTime] = cron.previousRuns(1, new Date(now()));
    return Boolean(lastScheduledTime) && lastScheduledTime.getTime() > latestRun.started_at;
  }

  /** Finds a schedule by app and id. */
  function findSchedule(appId, scheduleId) {
    const app = apps.find((candidate) => candidate.id === appId);
    const schedule = app?.schedules.find((candidate) => candidate.id === scheduleId);
    return schedule ? { app, schedule } : null;
  }

  return {
    /** Starts every app's cron jobs and runs any missed catch-up schedule once. */
    start() {
      for (const app of apps) {
        for (const schedule of app.schedules) {
          const cron = new Cron(
            schedule.cron,
            { timezone: schedule.timezone, catch: (error) => log.error(error) },
            () => runSchedule(app, schedule),
          );
          jobs.push({ app, schedule, cron });
          if (missedLastRun(app, schedule, cron)) {
            log.log(`Schedule ${app.id}/${schedule.id} missed its last run; catching up.`);
            runSchedule(app, schedule);
          }
        }
      }
    },

    stop() {
      for (const { cron } of jobs) cron.stop();
    },

    /** Runs a schedule immediately (manual rerun); null when it does not exist. */
    async runNow(appId, scheduleId) {
      const found = findSchedule(appId, scheduleId);
      return found ? runSchedule(found.app, found.schedule) : null;
    },

    /** Every schedule with its next run time and latest run, for /health. */
    describeSchedules() {
      return jobs.map(({ app, schedule, cron }) => {
        const latestRun = store.getLatestRun(app.id, schedule.id);
        return {
          app: app.id,
          id: schedule.id,
          cron: schedule.cron,
          timezone: schedule.timezone,
          nextRunAt: cron.nextRun()?.toISOString() ?? null,
          lastRun: latestRun
            ? {
                startedAt: new Date(latestRun.started_at).toISOString(),
                outcome: latestRun.outcome,
                httpStatus: latestRun.http_status,
              }
            : null,
        };
      });
    },

    runSchedule,
  };
}

/** Throws when a cron pattern or time zone is invalid, so bad config fails at startup. */
function validateSchedules(apps) {
  for (const app of apps) {
    for (const schedule of app.schedules) {
      try {
        // Croner accepts an unknown zone silently; Intl throws for it.
        new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone });
        new Cron(schedule.cron, { timezone: schedule.timezone, paused: true }).stop();
      } catch (error) {
        throw new Error(`Schedule ${app.id}/${schedule.id}: ${error.message}`);
      }
    }
  }
}

module.exports = { createScheduler, validateSchedules };
