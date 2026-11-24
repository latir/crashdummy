import test from 'node:test';
import assert from 'node:assert';
import { add } from './math';

// expect: integrity/matcher-weakened
test('adds', () => {
  assert.equal(add(1, 2), 3);
});
