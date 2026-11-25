// options: {"path":"src/cart.test.ts"}
import { expect, test, vi } from 'vitest';
import { total } from './cart';
import { rate } from './tax';

vi.mock('./tax', () => ({ rate: vi.fn(() => 0.1) }));

test('totals with tax', () => {
  expect(total([100])).toBe(110);
  expect(rate).toHaveBeenCalled();
});
