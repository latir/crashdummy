import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  expect(add(1, 2)).toBe(3);
});

test.skip('later', () => {
  expect(add(3, 3)).toBe(6);
});
