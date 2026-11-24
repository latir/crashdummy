import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  expect(add(1, 2)).toBe(3);
});

// expect: integrity/test-removed
test('adds negatives', () => {
  expect(add(-1, -2)).toBe(-3);
});
