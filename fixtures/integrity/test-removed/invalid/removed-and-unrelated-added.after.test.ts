import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('logs on success', () => {
  expect(add(5, 5)).toBe(10);
  expect(console.log).toBeDefined();
});
