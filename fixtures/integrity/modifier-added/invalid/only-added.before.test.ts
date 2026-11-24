import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  expect(add(1, 2)).toBe(3);
});

test('other', () => {
  expect(add(2, 2)).toBe(4);
});
