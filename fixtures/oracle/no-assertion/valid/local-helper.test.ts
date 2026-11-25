import { expect, test } from 'vitest';
import { add } from './add.js';

function check(a: number, b: number, sum: number) {
  expect(add(a, b)).toBe(sum);
}

test('adds numbers', () => {
  check(1, 2, 3);
});
