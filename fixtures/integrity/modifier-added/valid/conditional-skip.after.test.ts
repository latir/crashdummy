import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test.skipIf(process.env.CI === 'false')('adds', () => {
  expect(add(1, 2)).toBe(3);
});
