const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  unwrapDefault,
  firstValue,
  toInteger,
  toNumber,
} = require('#platform/fieldValue.js');
const { toJsonParam } = require('#platform/jsonParam.js');

test('field value helpers unwrap, pick, and coerce NHL values', () => {
  assert.equal(unwrapDefault({ default: 'Avalanche' }), 'Avalanche');
  assert.equal(unwrapDefault('COL'), 'COL');
  assert.equal(unwrapDefault(null), null);

  // firstValue skips nullish and blank values after unwrapping.
  assert.equal(firstValue(null, undefined, '', { default: 'COL' }), 'COL');
  assert.equal(firstValue(null, ''), null);

  // toInteger accepts whole numbers only; toNumber any finite number.
  assert.equal(toInteger('42'), 42);
  assert.equal(toInteger(42), 42);
  assert.equal(toInteger('42.5'), null);
  assert.equal(toInteger(''), null);
  assert.equal(toNumber('55.1'), 55.1);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber('not-a-number'), null);
  assert.equal(toNumber(Infinity), null);
});

test('toJsonParam stringifies objects and arrays for jsonb parameters', () => {
  assert.equal(toJsonParam({ a: 1 }), '{"a":1}');
  assert.equal(toJsonParam([{ network: 'ESPN' }], []), '[{"network":"ESPN"}]');
  assert.equal(toJsonParam(null, []), '[]');
});
