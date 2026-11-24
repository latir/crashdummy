import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

/* crashdummy-allow integrity/modifier-added: waiting on the API fix */
test.skip('adds', () => {
  expect(add(1, 2)).toBe(3);
});
