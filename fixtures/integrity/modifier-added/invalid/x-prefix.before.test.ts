import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

it('adds', () => {
  expect(add(1, 2)).toBe(3);
});
