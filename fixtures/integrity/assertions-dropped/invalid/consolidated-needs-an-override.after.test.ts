import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/assertions-dropped
test('adds', () => {
  const result = add(1, 2);
  expect(result).toEqual({ a: 1, b: 2 });
});
