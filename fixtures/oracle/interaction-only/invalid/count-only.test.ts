import { expect, test, vi } from 'vitest';
import { checkout } from './checkout.js';

test('charges once', () => {
  const charge = vi.fn();
  const receipt = checkout(charge);
  // expect: oracle/interaction-only
  expect(charge).toHaveBeenCalledTimes(1);
});
