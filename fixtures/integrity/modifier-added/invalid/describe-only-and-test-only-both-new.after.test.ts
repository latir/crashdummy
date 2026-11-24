import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/modifier-added
describe.only('math', () => {
  // expect: integrity/modifier-added
  test.only('adds', () => {
    expect(add(1, 2)).toBe(3);
  });
});
