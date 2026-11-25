import { expect, test } from 'vitest';
import { build } from './build.js';

test('builds', () => {
  const cart = build();
  expect(cart.total).toBe(0);
  expect(cart.items).toEqual([]);
});

test('a call is not a plain reference', () => {
  expect(build().total).toBe(build().total);
});

test('inequality with itself can fail', () => {
  const x = Number.NaN;
  expect(x).not.toBe(x);
});
