const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createStatLeaderService,
} = require('#slices/statLeaders/statLeaderService.js');

const CACHE_TYPES = { STAT_LEADERS: 'stat-leaders' };

/** Cache stub that always calls through to the fetcher (no persistence). */
const passthroughCache = {
  CACHE_TYPES,
  GetOrFetch: (type, key, fetcher) => fetcher(),
};

/** Never actually schedules background persistence in these tests. */
const noopRunServiceTask = () => null;

function makeService(axiosGet) {
  return createStatLeaderService({
    nhlApi: { axiosNhl: { get: axiosGet } },
    cache: passthroughCache,
    runServiceTask: noopRunServiceTask,
  });
}

test('getSkaterLeaders returns an empty list when the NHL API 404s the category', async () => {
  const service = makeService(async () => {
    const error = new Error('Request failed with status code 404');
    error.status = 404;
    throw error;
  });

  const result = await service.getSkaterLeaders('goals', '20252026');

  assert.deepEqual(result, []);
});

test('getGoalieLeaders returns an empty list when the NHL API 404s via error.response.status', async () => {
  const service = makeService(async () => {
    const error = new Error('Request failed with status code 404');
    error.response = { status: 404 };
    throw error;
  });

  const result = await service.getGoalieLeaders('shutouts', '20252026');

  assert.deepEqual(result, []);
});

test('getSkaterLeaders still throws on a non-404 failure', async () => {
  const service = makeService(async () => {
    throw new Error('network error');
  });

  await assert.rejects(
    () => service.getSkaterLeaders('goals', '20252026'),
    /network error/,
  );
});

test('getSkaterLeaders maps a normal successful payload', async () => {
  const service = makeService(async () => ({
    data: {
      goals: [
        {
          id: 1,
          firstName: { default: 'Connor' },
          lastName: { default: 'McDavid' },
          value: 12,
        },
      ],
    },
  }));

  const result = await service.getSkaterLeaders('goals', '20252026');

  assert.equal(result.length, 1);
  assert.equal(result[0].firstName, 'Connor');
  assert.equal(result[0].value, 12);
});
