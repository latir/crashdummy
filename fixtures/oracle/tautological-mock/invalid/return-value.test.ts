import { expect, test, vi } from 'vitest';

test('returns the stubbed value', () => {
  const price = vi.fn().mockReturnValue(42);
  // expect: oracle/tautological-mock
  expect(price()).toBe(42);
});
