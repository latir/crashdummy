import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('sums two numbers', () => {
  expect(add(1, 2)).toBe(3);
});
