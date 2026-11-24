import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/allow-unknown-rule
// crashdummy-allow integrity/modifier-addd: a typo
// expect: integrity/modifier-added
test.skip('adds', () => {
  expect(add(1, 2)).toBe(3);
});
