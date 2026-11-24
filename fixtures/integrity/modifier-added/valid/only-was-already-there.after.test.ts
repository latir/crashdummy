import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test.only('adds', () => {
  expect(add(1, 2)).toBe(3);
});
