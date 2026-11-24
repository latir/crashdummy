import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/matcher-weakened
test('rejects', () => {
  expect(() => parse('%%')).toThrow();
});
