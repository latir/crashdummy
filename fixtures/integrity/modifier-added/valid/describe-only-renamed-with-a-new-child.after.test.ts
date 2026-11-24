import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

describe.only('arithmetic', () => {
  test('adds', () => {
    expect(add(1, 2)).toBe(3);
  });
  test('parses', () => {
    expect(parse('7')).toBe(7);
  });
});
