import { it } from 'vitest';

// `expect` here is the helper's own parameter, so whether anything is asserted depends on the caller
function check(expect: (v: unknown) => { toBe(x: unknown): void }, value: unknown) {
  expect(value).toBe(1);
}

// expect: oracle/no-assertion
it('calls the helper with a no-op', () => {
  check(() => ({ toBe() {} }), 2);
});
