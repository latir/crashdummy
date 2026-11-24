import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/allow-without-reason
// crashdummy-allow integrity/modifier-added: ...
// expect: integrity/modifier-added
test.skip('adds', () => {
  expect(add(1, 2)).toBe(3);
});
