/**
 * Timer that keeps the current season's schedule cache warm. The refresh work
 * itself is injected (the schedule slice owns it), so this module stays free of
 * domain dependencies and starts no timers on import.
 */
const REFRESH_HOURS_UTC = [8, 19, 23];

/**
 * Waits for the next refresh hour (8AM, 7PM or 11PM UTC), runs
 * `refreshScheduleCache`, then schedules the following refresh.
 */
function scheduleNextRefresh(refreshScheduleCache) {
  const now = new Date();
  let nextRefreshMs = null;
  for (const hour of REFRESH_HOURS_UTC) {
    const candidate = new Date(now);
    candidate.setUTCHours(hour, 0, 0, 0);
    if (candidate.getTime() > now.getTime()) {
      nextRefreshMs = candidate.getTime();
      break;
    }
  }
  if (!nextRefreshMs) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(REFRESH_HOURS_UTC[0], 0, 0, 0);
    nextRefreshMs = tomorrow.getTime();
  }
  setTimeout(async () => {
    await refreshScheduleCache();
    scheduleNextRefresh(refreshScheduleCache);
  }, nextRefreshMs - now.getTime());
}

module.exports = {
  scheduleNextRefresh,
};
