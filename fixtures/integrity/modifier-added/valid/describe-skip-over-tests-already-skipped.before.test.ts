import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

describe('math', () => {
  test.skip('adds', () => {
    expect(add(1, 2)).toBe(3);
  });
  test.skip('parses', () => {
    expect(parse('7')).toBe(7);
  });
});
