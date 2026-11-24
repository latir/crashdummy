import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

function expectSum(result: number) {
  expect(result).toBe(3);
  expect(result).toBeGreaterThan(0);
}

test('adds', () => {
  expectSum(add(1, 2));
});
