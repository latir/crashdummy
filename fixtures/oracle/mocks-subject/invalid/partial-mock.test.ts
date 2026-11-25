// options: {"path":"src/cart.test.ts"}
import { expect, test, vi } from 'vitest';
import { total } from './cart';

// expect: oracle/mocks-subject
vi.mock('./cart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cart')>()),
  tax: vi.fn(() => 1),
}));

test('totals', () => {
  expect(total([])).toBe(1);
});
