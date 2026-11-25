import { test } from 'vitest';
import { add } from './add.js';

function run() {
  return add(1, 2);
}

// expect: oracle/no-assertion
test('adds numbers', () => {
  run();
});
