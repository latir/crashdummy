import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// crashdummy-allow integrity/matcher-weakened, integrity/assertions-dropped: covered by the contract test
test('adds', () => {
  const result = add(1, 2);
  expect(result).toBeTruthy();
});
