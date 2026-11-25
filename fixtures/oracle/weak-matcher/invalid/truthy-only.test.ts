import { expect, test } from 'vitest';
import { build } from './build.js';

test('builds a cart', () => {
  const cart = build();
  // expect: oracle/weak-matcher
  expect(cart).toBeTruthy();
});
