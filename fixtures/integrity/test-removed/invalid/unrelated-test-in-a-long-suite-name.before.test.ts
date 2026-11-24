import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

describe('shopping cart checkout flow', () => {
  // expect: integrity/test-removed
  test('rejects bad input', () => {
    expect(parse('%%')).toBe(null);
  });
});
