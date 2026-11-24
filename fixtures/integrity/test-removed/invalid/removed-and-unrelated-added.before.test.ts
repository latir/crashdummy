import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/test-removed
test('rejects bad input', () => {
  expect(() => parse('%%')).toThrow('bad input');
});
