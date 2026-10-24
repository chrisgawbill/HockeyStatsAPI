const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createStatLeaderService,
} = require('#slices/statLeaders/statLeaderService.js');

const CACHE_TYPES = { STAT_LEADERS: 'stat-leaders' };

/** Cache stub that always calls through to the fetcher (no persistence). */
const passthroughCache = {
  CACHE_TYPES,
  getOrFetchCached: (type, key, fetcher) => fetcher(),
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

function failingWith(fields) {
  return async () => {
    throw Object.assign(new Error('Request failed'), fields);
  };
}

test('leaders are empty when the NHL 404s the category, but other failures throw', async () => {
  // 404 reported either as error.status or error.response.status.
  assert.deepEqual(
    await makeService(failingWith({ status: 404 })).getSkaterLeaders(
      'goals',
      '20252026',
    ),
    [],
  );
  assert.deepEqual(
    await makeService(
      failingWith({ response: { status: 404 } }),
    ).getGoalieLeaders('shutouts', '20252026'),
    [],
  );
  await assert.rejects(
    () =>
      makeService(failingWith({ message: 'network error' })).getSkaterLeaders(
        'goals',
        '20252026',
      ),
    /network error/,
  );
});

test('an NHL 5xx for one category serves no leaders instead of failing', async () => {
  assert.deepEqual(
    await makeService(failingWith({ status: 500 })).getGoalieLeaders(
      'shutouts',
      '20262027',
    ),
    [],
  );
  assert.deepEqual(
    await makeService(
      failingWith({ response: { status: 503 } }),
    ).getSkaterLeaders('goals', '20262027'),
    [],
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

  const leaders = await service.getSkaterLeaders('goals', '20252026');

  assert.equal(leaders.length, 1);
  assert.equal(leaders[0].firstName, 'Connor');
  assert.equal(leaders[0].value, 12);
});
