import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  expect(add(1, 2)).toBe(3);
});

test('legacy', () => {
  expect(add(0, 0)).toBe(0);
});
