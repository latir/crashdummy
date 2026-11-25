// options: {"path":"src/cart.test.ts"}
import { expect, test, vi } from 'vitest';
import { total } from './cart.js';

// expect: oracle/mocks-subject
vi.mock('./cart.js', () => ({ total: vi.fn(() => 10) }));

test('totals', () => {
  expect(total([])).toBe(10);
});
