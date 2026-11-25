import { expect, test } from 'vitest';
import { build } from './build.js';

test('builds a cart', () => {
  const cart = build();
  const total = cart.total;
  // expect: oracle/weak-matcher
  expect(cart).toBeDefined();
  expect(total).toBe(10);
});
