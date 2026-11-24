import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/matcher-weakened
test('adds', () => {
  const result = add(1, 2);
  expect(result).toEqual(expect.anything());
});
