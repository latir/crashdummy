import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  const result = add(1, 2);
  expect(result).toBe(3);
  expect(result).toBeGreaterThan(0);
});
