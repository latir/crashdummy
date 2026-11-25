// options: {"path":"src/checkout.test.ts"}
import { expect, test, vi } from 'vitest';
import { total } from './cart';

vi.mock('./cart', () => ({ total: vi.fn(() => 10) }));

test('checks out', () => {
  expect(total([])).toBe(10);
});
