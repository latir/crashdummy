import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { strictEqual, ok } from 'node:assert';
import { sum } from './sum.js';

describe('sum', () => {
  test('adds', () => {
    assert.equal(sum(1, 2), 3);
    assert.deepStrictEqual(sum(1, 1), 2);
    assert(sum(0, 0) === 0);
  });

  test('throws', (t) => {
    assert.throws(() => sum('a'));
    assert.throws(() => sum('a'), /number/);
    t.assert.equal(sum(2, 2), 4);
    assert.notStrictEqual(sum(1, 1), 3);
  });

  test('named imports', () => {
    strictEqual(sum(1, 1), 2);
    ok(sum(1, 1));
  });

  test('skipped with options', { skip: 'not yet', timeout: 1000 }, () => {
    assert.ok(true);
  });
});
