import { describe, test, it, expect } from 'vitest';

test.each([
  [1, 1, 2],
  [2, 2, 4],
])('adds %i + %i', (a, b, sum) => {
  expect(a + b).toBe(sum);
});

describe.each([{ n: 1 }, { n: 2 }])('suite $n', ({ n }) => {
  it('is positive', () => {
    expect(n).toBeGreaterThan(0);
  });
});

test.each`
  a    | b    | expected
  ${1} | ${1} | ${2}
  ${2} | ${2} | ${4}
`('template adds $a + $b', ({ a, b, expected }) => {
  expect(a + b).toBe(expected);
});

it.skip.each([1, 2])('skipped %i', (n) => {
  expect(n).toBeTruthy();
});
