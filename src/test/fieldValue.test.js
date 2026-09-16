const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  unwrapDefault,
  firstValue,
  toInteger,
  toNumber,
} = require('#platform/fieldValue.js');

test('unwrapDefault returns NHL default values when present', () => {
  assert.equal(unwrapDefault({ default: 'Avalanche' }), 'Avalanche');
  assert.equal(unwrapDefault('COL'), 'COL');
  assert.equal(unwrapDefault(null), null);
});

test('firstValue skips nullish and blank values after unwrapping', () => {
  assert.equal(firstValue(null, undefined, '', { default: 'COL' }), 'COL');
  assert.equal(firstValue(null, ''), null);
});

test('toInteger accepts whole numeric values only', () => {
  assert.equal(toInteger('42'), 42);
  assert.equal(toInteger(42), 42);
  assert.equal(toInteger('42.5'), null);
  assert.equal(toInteger(''), null);
});

test('toNumber accepts finite numeric values', () => {
  assert.equal(toNumber('55.1'), 55.1);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber('not-a-number'), null);
  assert.equal(toNumber(Infinity), null);
});
