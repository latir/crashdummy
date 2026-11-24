import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds two numbers correctly', () => {
  expect(add(2, 2)).toBe(4);
});
