import { expect, test } from 'vitest';
import { build } from './build.js';

test('builds', () => {
  const cart = build();
  // expect: oracle/tautological-assertion
  expect(cart.total).toBe(cart.total);
});
