import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveImport, resolveImports } from '../../src/parse/index.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'crashdummy-resolve-'));
  for (const f of [
    'src/cart.ts',
    'src/cart/index.ts',
    'src/util.tsx',
    'src/esm.ts',
    'src/lib/format.ts',
    'src/lib/dates/index.js',
    'src/plain.js',
    'src/data.json',
    'shared/money.ts',
  ]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), '');
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('relative imports', () => {
  const r = (spec: string, from = 'src/cart.test.ts') => resolveImport(spec, from, { cwd: root });

  test.each([
    ['./util', 'src/util.tsx'],
    ['./plain', 'src/plain.js'],
    ['./plain.js', 'src/plain.js'],
    ['./lib/format', 'src/lib/format.ts'],
    ['./lib/dates', 'src/lib/dates/index.js'],
    ['../shared/money', 'shared/money.ts'],
  ])('%s -> %s', (spec, expected) => {
    expect(r(spec)).toBe(expected);
  });

  test('a file wins over a directory of the same name', () => {
    expect(r('./cart')).toBe('src/cart.ts');
  });

  test("ESM '.js' specifiers find the '.ts' source", () => {
    expect(r('./esm.js')).toBe('src/esm.ts');
  });

  test('resolves from the importing file directory', () => {
    expect(resolveImport('./format', 'src/lib/x.test.ts', { cwd: root })).toBe('src/lib/format.ts');
  });

  test('missing files, non-code files and paths outside the repo are unresolved', () => {
    expect(r('./nope')).toBeUndefined();
    expect(r('./data.json')).toBeUndefined();
    expect(r('../../outside')).toBeUndefined();
  });
});

describe('bare packages', () => {
  test('are left unresolved on purpose', () => {
    expect(resolveImport('vitest', 'src/a.test.ts', { cwd: root })).toBeUndefined();
    expect(resolveImport('@scope/pkg', 'src/a.test.ts', { cwd: root })).toBeUndefined();
  });
});

describe('tsconfig paths', () => {
  const paths = { '@/*': ['src/*'], '~shared/*': ['shared/*'], exact: ['src/cart'] };

  test('wildcard and exact patterns', () => {
    const o = { cwd: root, paths };
    expect(resolveImport('@/util', 'x/a.test.ts', o)).toBe('src/util.tsx');
    expect(resolveImport('@/lib/format', 'x/a.test.ts', o)).toBe('src/lib/format.ts');
    expect(resolveImport('~shared/money', 'x/a.test.ts', o)).toBe('shared/money.ts');
    expect(resolveImport('exact', 'x/a.test.ts', o)).toBe('src/cart.ts');
  });

  test('tries each target in order and respects baseUrl', () => {
    const o = { cwd: root, baseUrl: 'src', paths: { '#/*': ['missing/*', 'lib/*'] } };
    expect(resolveImport('#/format', 'a.test.ts', o)).toBe('src/lib/format.ts');
  });

  test('a pattern that matches nothing is unresolved', () => {
    expect(resolveImport('@/nope', 'a.test.ts', { cwd: root, paths })).toBeUndefined();
  });
});

describe('resolveImports', () => {
  test('drops unresolved specifiers and duplicates, keeps order', () => {
    expect(
      resolveImports(
        ['vitest', './util', './util.tsx', './missing', './lib/format'],
        'src/a.test.ts',
        { cwd: root },
      ),
    ).toEqual(['src/util.tsx', 'src/lib/format.ts']);
  });

  test('takes an injected exists function', () => {
    const seen: string[] = [];
    resolveImports(['./a'], 'src/x.test.ts', {
      cwd: '/virtual',
      exists: (p) => (seen.push(p), p === '/virtual/src/a.ts'),
    });
    expect(seen.at(-1)).toBe('/virtual/src/a.ts');
  });
});
