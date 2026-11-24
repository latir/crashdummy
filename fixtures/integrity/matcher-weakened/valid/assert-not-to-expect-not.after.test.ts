import { test, expect } from 'vitest';
import { parse } from './math';

test('rejects', () => {
  expect(parse('a')).not.toBe('bad');
});
