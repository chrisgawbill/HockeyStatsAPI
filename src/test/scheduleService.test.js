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

test('getSeasonSchedule walks the full season (Sept 1 - next June 30) for the current season', async () => {
  const axios = makeRecordingAxios();
  const service = makeService(axios, '20262027');

  await service.getSeasonSchedule('20262027');

  assert.equal(axios.requestedDates[0], '2026-09-01');
  const last = axios.requestedDates[axios.requestedDates.length - 1];
  // Weekly steps of 7 days from Sept 1 land within the final week of June.
  assert.ok(last >= '2027-06-24' && last <= '2027-06-30', `got ${last}`);
});

test('getSeasonSchedule walks the same full-season range for a past season', async () => {
  const axios = makeRecordingAxios();
  const service = makeService(axios, '20262027');

  await service.getSeasonSchedule('20242025');

  assert.equal(axios.requestedDates[0], '2024-09-01');
  const last = axios.requestedDates[axios.requestedDates.length - 1];
  assert.ok(last >= '2025-06-24' && last <= '2025-06-30', `got ${last}`);
});

test('getSeasonSchedule requests the identical range whether or not the season is current', async () => {
  const axiosCurrent = makeRecordingAxios();
  const axiosPast = makeRecordingAxios();

  await makeService(axiosCurrent, '20262027').getSeasonSchedule('20262027');
  await makeService(axiosPast, '20999999').getSeasonSchedule('20262027');

  assert.deepEqual(axiosCurrent.requestedDates, axiosPast.requestedDates);
});
