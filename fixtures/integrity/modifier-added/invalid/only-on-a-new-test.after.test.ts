import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  expect(add(1, 2)).toBe(3);
});

// expect: integrity/modifier-added
test.only('brand new', () => {
  expect(add(9, 9)).toBe(18);
});
