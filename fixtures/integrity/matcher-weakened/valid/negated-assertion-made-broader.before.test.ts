import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('rejects', () => {
  expect(parse('a')).not.toEqual({ a: 1, b: 2 });
});
