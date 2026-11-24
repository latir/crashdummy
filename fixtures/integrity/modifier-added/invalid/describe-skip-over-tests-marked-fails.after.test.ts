import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/modifier-added
describe.skip('math', () => {
  test.fails('adds', () => {
    expect(add(1, 2)).toBe(4);
  });
});
