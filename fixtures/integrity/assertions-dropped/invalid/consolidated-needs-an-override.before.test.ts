import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  const result = add(1, 2);
  expect(result.a).toBe(1);
  expect(result.b).toBe(2);
});
