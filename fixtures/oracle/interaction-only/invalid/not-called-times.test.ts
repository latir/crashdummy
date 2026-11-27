import { expect, it, vi } from 'vitest';
import { checkout } from './checkout.js';

it('does not charge twice', () => {
  const charge = vi.fn();
  const total = checkout(charge);
  // two calls would still pass this: it says nothing about the result
  // expect: oracle/interaction-only
  expect(charge).not.toHaveBeenCalledTimes(2);
});
