import { expect, test } from 'vitest';

test('always true', () => {
  // expect: oracle/tautological-assertion
  expect(true).toBe(true);
});

test('object literals', () => {
  // expect: oracle/tautological-assertion
  expect({ a: 1 }).toEqual({ a: 1 });
});
