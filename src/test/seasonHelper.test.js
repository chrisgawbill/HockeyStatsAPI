const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INVALID_SEASON_MSG,
  getCurrentSeasonId,
  isValidSeasonId,
} = require('#platform/seasonHelper.js');
const {
  validateSeason,
} = require('#presentation/middleware/validateSeason.js');

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test('isValidSeasonId accepts only eight-digit consecutive season ids', () => {
  for (const id of ['20232024', '20252026']) {
    assert.equal(isValidSeasonId(id), true, id);
  }
  for (const id of ['2023', '20232025', 'abcd2024', '', undefined]) {
    assert.equal(isValidSeasonId(id), false, String(id));
  }
});

test('getCurrentSeasonId rolls over to the new season on September 1', () => {
  assert.equal(getCurrentSeasonId(new Date(2026, 7, 31)), '20252026');
  assert.equal(getCurrentSeasonId(new Date(2026, 8, 1)), '20262027');
  assert.equal(getCurrentSeasonId(new Date(2026, 11, 15)), '20262027');
  assert.equal(getCurrentSeasonId(new Date(2027, 0, 15)), '20262027');
});

test('validateSeason sets req.seasonId (explicit or current) or responds 400', () => {
  const run = (query) => {
    const req = { query };
    const res = makeResponse();
    let nextCalled = false;
    validateSeason(req, res, () => {
      nextCalled = true;
    });
    return { req, res, nextCalled };
  };

  for (const [query, expected] of [
    [{ season: '20232024' }, '20232024'],
    [{}, getCurrentSeasonId()],
  ]) {
    const { req, res, nextCalled } = run(query);
    assert.equal(nextCalled, true);
    assert.equal(req.seasonId, expected);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  }

  const bad = run({ season: 'bad' });
  assert.equal(bad.nextCalled, false);
  assert.equal(bad.req.seasonId, undefined);
  assert.equal(bad.res.statusCode, 400);
  assert.deepEqual(bad.res.body, { error: INVALID_SEASON_MSG });
});
