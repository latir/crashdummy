import { expect, test, vi } from 'vitest';
import { checkout } from './checkout.js';

test('checks out', () => {
  const pay = vi.fn();
  const receipt = checkout(pay);
  // expect: oracle/interaction-only
  expect(pay).toHaveBeenCalled();
});
