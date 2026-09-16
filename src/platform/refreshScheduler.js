/**
 * Timer that keeps the current season's schedule cache warm. The refresh work
 * itself is injected (the schedule slice owns it), so this module stays free of
 * domain dependencies and starts no timers on import.
 */
// Schedule cache refreshes at 8AM, 7PM, 11PM UTC
const REFRESH_HOURS_UTC = [8, 19, 23];

function scheduleNextRefresh(refreshScheduleCache) {
  const now = new Date();
  let nextMs = null;
  for (const hour of REFRESH_HOURS_UTC) {
    const candidate = new Date(now);
    candidate.setUTCHours(hour, 0, 0, 0);
    if (candidate.getTime() > now.getTime()) {
      nextMs = candidate.getTime();
      break;
    }
  }
  if (!nextMs) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(REFRESH_HOURS_UTC[0], 0, 0, 0);
    nextMs = tomorrow.getTime();
  }
  setTimeout(async () => {
    await refreshScheduleCache();
    scheduleNextRefresh(refreshScheduleCache);
  }, nextMs - now.getTime());
}

module.exports = {
  scheduleNextRefresh,
};
