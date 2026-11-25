import { expect, test } from 'vitest';
import { build } from './build.js';

test('builds a cart', () => {
  const cart = build();
  expect(cart).toBeDefined();
  expect(cart).toEqual({ items: [], total: 0 });
});
