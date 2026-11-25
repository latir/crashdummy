import { test } from 'vitest';
import { add } from './add.js';

// expect: oracle/no-assertion
test('adds numbers', () => {
  add(1, 2);
});
