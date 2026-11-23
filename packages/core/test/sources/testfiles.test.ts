import { describe, expect, test } from 'vitest';
import { DEFAULT_TEST_GLOBS, globToRegExp, isTestFile } from '../../src/sources/testfiles.js';

describe('default test globs', () => {
  test.each([
    'cart.test.ts',
    'src/cart/cart.test.ts',
    'src/cart/cart.spec.tsx',
    'a/b/c.test.js',
    'x.spec.mjs',
    'x.test.cts',
    'x.test.mts',
    'x.test.jsx',
    'src/__tests__/cart.ts',
    'src/a/__tests__/deep/cart.js',
    'e2e/checkout.ts',
    'e2e/flows/checkout.spec.ts',
  ])('matches %s', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  test.each([
    'src/cart/cart.ts',
    'src/cart/cart.test.ts.snap',
    'src/cart/test.ts',
    'src/cart/cart.tests.ts',
    'src/__tests__/__snapshots__/cart.snap',
    'src/__tests__/data.json',
    'pkg/e2e/checkout.ts',
    'README.md',
  ])('does not match %s', (path) => {
    expect(isTestFile(path)).toBe(false);
  });

  test('has the three patterns from the plan', () => {
    expect(DEFAULT_TEST_GLOBS).toHaveLength(3);
  });
});

describe('testGlobs override', () => {
  test('replaces the defaults', () => {
    const globs = ['**/*.check.ts'];
    expect(isTestFile('src/a.check.ts', globs)).toBe(true);
    expect(isTestFile('src/a.test.ts', globs)).toBe(false);
  });
});

describe('globToRegExp', () => {
  test.each([
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'a/b/c.ts', true],
    ['*.ts', 'a/b.ts', false],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'other/a.ts', false],
    ['a?c.ts', 'abc.ts', true],
    ['a?c.ts', 'a/c.ts', false],
    ['*.{ts,js}', 'x.js', true],
    ['*.{ts,js}', 'x.md', false],
    ['a.b', 'axb', false],
    ['(a)+.ts', '(a)+.ts', true],
  ])('%s vs %s -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
