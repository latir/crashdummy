import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('x', () => {
  expect(add(2, 2)).toBeTruthy();
});

test('x', () => {
  expect(add(1, 1)).toEqual(2);
});
