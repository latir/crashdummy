// crashdummy-allow integrity/test-removed: the legacy path was deleted in the API v2 cleanup
import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('adds', () => {
  expect(add(1, 2)).toBe(3);
});
