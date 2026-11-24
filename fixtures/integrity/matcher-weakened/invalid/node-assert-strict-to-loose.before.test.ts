import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math';

test('adds', () => {
  assert.equal(add(1, 2), 3);
});
