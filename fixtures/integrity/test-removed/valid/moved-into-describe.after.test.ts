import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

describe('math', () => {
  test('adds', () => {
    expect(add(1, 2)).toBe(3);
  });
});
