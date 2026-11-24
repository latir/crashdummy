import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

const expected = 3;

test('adds', () => {
  expect(add(1, 2)).toBe(expected);
});
