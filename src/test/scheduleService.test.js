const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createScheduleService,
} = require('#slices/schedule/scheduleService.js');

const CACHE_TYPES = { SCHEDULE: 'schedule' };

/** Cache stub that always calls through to the fetcher (no persistence). */
const passthroughCache = {
  CACHE_TYPES,
  GetOrFetch: (type, key, fetcher) => fetcher(),
  writeCache: async () => {},
};

const noopRunServiceTask = () => null;

/** Records every NHL weekly-schedule date requested; returns an empty week. */
function makeRecordingAxios() {
  const requestedDates = [];
  return {
    requestedDates,
    get: async (url) => {
      const match = url.match(/^\/schedule\/(\d{4}-\d{2}-\d{2})$/);
      if (match) requestedDates.push(match[1]);
      return { data: { gameWeek: [] } };
    },
  };
}

function makeService(axiosGet, currentSeasonId) {
  return createScheduleService({
    nhlApi: { axiosNhl: axiosGet },
    cache: passthroughCache,
    seasons: { getCurrentSeasonId: () => currentSeasonId },
    runServiceTask: noopRunServiceTask,
  });
}

test('getSeasonSchedule walks Sept 1 - next June 30 for current and past seasons alike', async () => {
  const lastWeekOf = (dates) => dates[dates.length - 1];
  const current = makeRecordingAxios();
  await makeService(current, '20262027').getSeasonSchedule('20262027');
  assert.equal(current.requestedDates[0], '2026-09-01');
  // Weekly steps of 7 days from Sept 1 land within the final week of June.
  const last = lastWeekOf(current.requestedDates);
  assert.ok(last >= '2027-06-24' && last <= '2027-06-30', `got ${last}`);

  const past = makeRecordingAxios();
  await makeService(past, '20262027').getSeasonSchedule('20242025');
  assert.equal(past.requestedDates[0], '2024-09-01');
  const pastLast = lastWeekOf(past.requestedDates);
  assert.ok(pastLast >= '2025-06-24' && pastLast <= '2025-06-30');

  // The range does not depend on whether the season is current.
  const notCurrent = makeRecordingAxios();
  await makeService(notCurrent, '20999999').getSeasonSchedule('20262027');
  assert.deepEqual(notCurrent.requestedDates, current.requestedDates);
});
