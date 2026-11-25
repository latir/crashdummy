import assert from 'node:assert/strict';
import { test } from 'node:test';

test('compares a number with itself', () => {
  const n = 3;
  // expect: oracle/tautological-assertion
  assert.equal(n, n);
});
