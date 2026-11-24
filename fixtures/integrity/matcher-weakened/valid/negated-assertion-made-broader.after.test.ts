import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('rejects', () => {
  expect(parse('a')).not.toMatchObject({ a: 1 });
});
