const assert = require('node:assert/strict');
const { test } = require('node:test');

const { toJsonParam } = require('#platform/jsonParam.js');

test('toJsonParam stringifies objects and arrays for jsonb parameters', () => {
  assert.equal(toJsonParam({ a: 1 }), '{"a":1}');
  assert.equal(toJsonParam([{ network: 'ESPN' }], []), '[{"network":"ESPN"}]');
  assert.equal(toJsonParam(null, []), '[]');
});
