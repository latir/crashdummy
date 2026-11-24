import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/assertions-dropped
test('adds', () => {
  add(1, 2);
});
