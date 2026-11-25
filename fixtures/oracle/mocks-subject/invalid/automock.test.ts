// options: {"path":"src/cart.test.ts"}
import { expect, test, vi } from 'vitest';
import { total } from './cart';

// expect: oracle/mocks-subject
vi.mock('./cart');

test('totals', () => {
  expect(total([])).toBeUndefined();
});
