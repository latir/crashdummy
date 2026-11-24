import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/test-removed
test('adds', () => {
  expect(add(1, 2)).toBe(3);
});

// expect: integrity/test-removed
test('parses', () => {
  expect(parse('1')).toBe(1);
});
