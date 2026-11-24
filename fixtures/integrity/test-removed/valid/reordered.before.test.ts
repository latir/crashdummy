import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('first', () => {
  expect(add(1, 1)).toBe(2);
});

test('second', () => {
  expect(add(2, 2)).toBe(4);
});
