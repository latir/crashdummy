import { describe, expect, test } from 'vitest';
import { ParseError } from '../../src/errors.js';
import { SummaryCache, analyzeTestFile, summarizeTestFile } from '../../src/parse/index.js';
import { shape, summarize, summarizeFixture } from './helpers.js';

describe('nested describes', () => {
  const s = summarizeFixture('nested-describes.test.ts');

  test('ids are the describe path plus the test name', () => {
    expect(s.tests.map((t) => t.id)).toEqual([
      'cart > adding > adds an item',
      'cart > adding > adds an item #2',
      'cart > removing > removes an item',
      'cart > is empty by default',
    ]);
  });

  test('duplicate ids get a numeric suffix so they stay unique', () => {
    expect(new Set(s.tests.map((t) => t.id)).size).toBe(s.tests.length);
  });

  test('matchers are in order of appearance with strengths from the lattice', () => {
    expect(shape(s)).toEqual({
      'cart > adding > adds an item': ['toStrictEqual:4', 'toHaveLength:3'],
      'cart > adding > adds an item #2': ['toEqual:4'],
      'cart > removing > removes an item': ['!toContainEqual:2'],
      'cart > is empty by default': ['toBeDefined:1'],
    });
  });

  test('framework and imports', () => {
    expect(s.framework).toBe('vitest');
    expect(s.imports).toEqual(['vitest', './cart']);
  });

  test('locations are 1-based line and column of the test call', () => {
    expect(s.tests.map((t) => t.loc)).toEqual([
      { line: 6, col: 5 },
      { line: 12, col: 5 },
      { line: 18, col: 5 },
      { line: 23, col: 3 },
    ]);
  });
});

describe('.each', () => {
  const s = summarizeFixture('each.test.ts');

  test('table and template forms are one test case each, named by their title', () => {
    expect(s.tests.map((t) => t.id)).toEqual([
      'adds %i + %i',
      'suite $n > is positive',
      'template adds $a + $b',
      'skipped %i',
    ]);
  });

  test('matchers inside .each callbacks are recorded', () => {
    expect(shape(s)['adds %i + %i']).toEqual(['toBe:3']); // toBe(<identifier>) is not a literal
  });

  test('modifiers combine with .each', () => {
    expect(s.tests.find((t) => t.id === 'skipped %i')?.modifier).toBe('skip');
  });
});

describe('async tests', () => {
  const s = summarizeFixture('async.test.ts');

  test('.resolves and .rejects do not hide the matcher', () => {
    expect(shape(s)).toEqual({
      'loads a user': ['toBe:4'],
      'resolves with the user': ['toEqual:4'],
      'rejects with a message': ['toThrow:3', 'toThrow:2', '!toBeNull:1'],
      'slow one': ['toBeTruthy:1'],
      'with options': ['toBe:4'],
    });
  });

  test('timeouts from a third argument, an options object, and numeric folding', () => {
    expect(Object.fromEntries(s.tests.map((t) => [t.id, t.timeoutMs]))).toEqual({
      'loads a user': undefined,
      'resolves with the user': undefined,
      'rejects with a message': undefined,
      'slow one': 20000,
      'with options': 5000,
    });
  });
});

describe('custom assertion helpers', () => {
  const s = summarizeFixture('helpers.test.ts');

  test('local helpers are followed one level deep, at the call site', () => {
    expect(shape(s)).toEqual({
      'uses a helper function': ['toBe:4', 'toEqual:4'],
      'uses an arrow helper and its own assertion': ['toBeTruthy:1', 'toBe:4'],
      'calls helper twice': ['toBe:4', 'toEqual:4', 'toBe:4', 'toEqual:4'],
      'helper that calls a helper is followed one level only': [],
      'custom assert-style helper': [],
      'has no assertions at all': [],
    });
  });

  test('assertFunctionNames counts configured helpers as assertions', () => {
    const withNames = summarizeFixture('helpers.test.ts', { assertFunctionNames: ['check*'] });
    expect(shape(withNames)['custom assert-style helper']).toEqual(['checkTotals:2']);
    expect(shape(withNames)['has no assertions at all']).toEqual([]);
  });

  test('assertFunctionNames matches dotted paths', () => {
    const s2 = summarize(
      'a.test.ts',
      `test('x', () => { helpers.verifyOk(1); other.verifyOk(2); });`,
      { assertFunctionNames: ['helpers.verify*'] },
    );
    expect(shape(s2)).toEqual({ x: ['helpers.verifyOk:2'] });
  });

  test('a function named expectX or assertX counts by its name, as a custom assertion', () => {
    const s2 = summarize('a.test.ts', `test('x', () => { helpers.expectOk(1); assertValid(2); });`);
    expect(shape(s2)).toEqual({ x: ['helpers.expectOk:2', 'assertValid:2'] });
  });

  test('a test whose body is a named local function follows it', () => {
    const s2 = summarize('a.test.ts', `function body() { expect(1).toBe(1); }\ntest('x', body);`);
    expect(shape(s2)).toEqual({ x: ['toBe:4'] });
  });
});

describe('modifiers', () => {
  const s = summarizeFixture('modifiers.test.ts');
  const mod = (id: string) => s.tests.find((t) => t.id === id)?.modifier;

  test('skip, only, todo, fails, x- and f- prefixes, and option objects', () => {
    expect(mod('mixed > skipped')).toBe('skip');
    expect(mod('mixed > only')).toBe('only');
    expect(mod('mixed > todo one')).toBe('todo');
    expect(mod('mixed > known bug')).toBe('fails');
    expect(mod('mixed > x skipped')).toBe('skip');
    expect(mod('mixed > f only')).toBe('only');
    expect(mod('top-level skip')).toBe('skip');
    expect(mod('options skip')).toBe('skip');
  });

  test('a modifier on describe is inherited; a test modifier wins', () => {
    expect(mod('skipped suite > inherits skip')).toBe('skip');
    expect(mod('skipped suite > own only wins')).toBe('only');
  });

  test('conditional skips and disabled options set no modifier', () => {
    expect(mod('mixed > conditional')).toBeUndefined();
    expect(mod('options not skipped')).toBeUndefined();
    expect(mod('mixed > plain')).toBeUndefined();
  });

  test('a todo test has no body to assert on', () => {
    expect(s.tests.find((t) => t.id === 'mixed > todo one')?.matchers).toEqual([]);
  });
});

describe('mocks', () => {
  const s = summarizeFixture('mocks.test.ts');

  test('subjectIsMock for vi.fn, spyOn, .mock access, derived values and mocked imports', () => {
    expect(shape(s)).toEqual({
      'asserts on a mock function': [
        'toHaveBeenCalledWith:3@mock',
        'toEqual:4@mock',
        '!toHaveBeenCalled:2@mock',
      ],
      'asserts on the return of a mock': ['toBeUndefined:3@mock'],
      'asserts on an auto-mocked import': ['toEqual:4@mock'],
      'asserts on real code': ['toBe:4', 'toBeDefined:1@mock'],
    });
  });
});

describe('Playwright', () => {
  const s = summarizeFixture('playwright.spec.ts');

  test('web-first matchers, expect.soft and expect.poll', () => {
    expect(shape(s)).toEqual({
      'checkout > shows the total': ['toHaveText:4', 'toBeVisible:2', 'toContainText:3'],
      'checkout > broken flow': ['toHaveURL:3'],
      'checkout > conditional skip inside the body is not a test': ['toHaveTitle:3'],
      'top level with a timeout': ['toBe:4'],
    });
    expect(s.framework).toBe('playwright');
  });

  test('test.fixme is a modifier; test.skip(condition) inside a body is not a declaration', () => {
    expect(s.tests.map((t) => [t.id, t.modifier])).toEqual([
      ['checkout > shows the total', undefined],
      ['checkout > broken flow', 'fixme'],
      ['checkout > conditional skip inside the body is not a test', undefined],
      ['top level with a timeout', undefined],
    ]);
  });

  test('describe.configure and test.setTimeout set timeouts', () => {
    expect(s.tests.map((t) => t.timeoutMs)).toEqual([60000, 60000, 60000, 90000]);
  });
});

describe('node:test and node:assert', () => {
  const s = summarizeFixture('node-test.test.ts');

  test('assert.*, t.assert.*, named imports and bare assert()', () => {
    expect(shape(s)).toEqual({
      'sum > adds': ['assert.strictEqual:4', 'assert.deepStrictEqual:4', 'assert.ok:1'], // bare assert(x) is assert.ok
      'sum > throws': [
        'assert.throws:2',
        'assert.throws:3',
        'assert.equal:3',
        '!assert.notStrictEqual:2',
      ],
      'sum > named imports': ['assert.strictEqual:4', 'assert.ok:1'],
      'sum > skipped with options': ['assert.ok:1'],
    });
    expect(s.framework).toBe('node-test');
  });

  test('options object: skip with a reason, timeout', () => {
    const t = s.tests.find((x) => x.id === 'sum > skipped with options');
    expect(t).toMatchObject({ modifier: 'skip', timeoutMs: 1000 });
  });
});

describe('Jest globals', () => {
  const s = summarizeFixture('jest-globals.test.js');

  test('framework is detected from globals, jest.setTimeout applies to the file', () => {
    expect(s.framework).toBe('jest');
    expect(s.tests.map((t) => t.timeoutMs)).toEqual([15000, 15000]);
    expect(s.imports).toEqual(['./sum']); // require()
  });
});

describe('framework detection', () => {
  test.each([
    [`import { test } from 'vitest'; test('a', () => {});`, 'vitest'],
    [`import { test } from '@jest/globals'; test('a', () => {});`, 'jest'],
    [`import { test } from '@playwright/test'; test('a', async () => {});`, 'playwright'],
    [`import { test } from 'node:test'; test('a', () => {});`, 'node-test'],
    [`vi.fn(); test('a', () => {});`, 'vitest'],
    [`jest.fn(); test('a', () => {});`, 'jest'],
    [`test('a', () => {});`, 'unknown'],
  ])('%s -> %s', (source, framework) => {
    expect(summarize('a.test.ts', source).framework).toBe(framework);
  });
});

describe('imports', () => {
  test('static, type-only, re-exports, dynamic import and require', () => {
    const s = summarize(
      'a.test.ts',
      `import a from './a';
       import type { T } from './types';
       import './side-effect';
       export * from './re';
       export { x } from './re2';
       const b = require('./b');
       test('x', async () => { await import('./dyn'); });`,
    );
    expect(s.imports).toEqual(['./a', './side-effect', './re', './re2', './b', './dyn']);
  });
});

describe('matcher overrides', () => {
  test('user overrides change the recorded strength', () => {
    const src = `test('x', () => { expect(1).toBeWithinRange(1, 3); });`;
    expect(shape(summarize('a.test.ts', src))).toEqual({ x: ['toBeWithinRange:2'] });
    const custom = summarize('a.test.ts', src, { matchers: { toBeWithinRange: { strength: 4 } } });
    expect(shape(custom)).toEqual({ x: ['toBeWithinRange:4'] });
  });
});

describe('what is not a test', () => {
  test('hooks, test.step and calls without a function are ignored', () => {
    const s = summarize(
      'a.test.ts',
      `beforeEach(() => { expect(1).toBe(1); });
       test('real', async () => { await test.step('s', async () => { expect(2).toBe(2); }); });
       test.skip(true, 'why');`,
    );
    expect(shape(s)).toEqual({ real: ['toBe:4'] });
  });

  test('a test nested in a test body is not a second test', () => {
    const s = summarize(
      'a.test.ts',
      `test('outer', () => { test('inner', () => { expect(1).toBe(1); }); });`,
    );
    expect(s.tests.map((t) => t.id)).toEqual(['outer']);
  });

  test('an empty file', () => {
    expect(summarize('a.test.ts', '')).toMatchObject({
      tests: [],
      imports: [],
      framework: 'unknown',
    });
  });
});

describe('syntax errors', () => {
  const broken = `test('ok', () => { expect(1).toBe(1); });\nconst = ;`;

  test('analyzeTestFile reports errors and an empty summary: never read that as "no tests"', () => {
    const a = analyzeTestFile('a.test.ts', broken, { resolve: false });
    expect(a.errors).toEqual([{ message: 'Unexpected token', line: 2, col: 7 }]);
    expect(a.summary.tests).toEqual([]);
  });

  test('summarizeTestFile throws a ParseError naming the file', () => {
    expect(() => summarizeTestFile('a.test.ts', broken, { resolve: false })).toThrow(ParseError);
    expect(() => summarizeTestFile('a.test.ts', broken, { resolve: false })).toThrow(
      'a.test.ts:2:7: Unexpected token',
    );
  });

  test('a failed parse is not cached', () => {
    const cache = new SummaryCache();
    expect(() => summarizeTestFile('a.test.ts', broken, { resolve: false, cache })).toThrow();
    expect(cache.size).toBe(0);
  });
});

test('summaries are JSON-serializable and stable', () => {
  const s = summarizeFixture('nested-describes.test.ts');
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  expect(summarizeFixture('nested-describes.test.ts')).toEqual(s);
});

describe('every modifier on a test is recorded, not just the winner', () => {
  test("describe modifiers come first, then the test's own", () => {
    const s = summarize(
      'a.test.ts',
      `describe.only('outer', () => {\n  describe.skip('inner', () => {\n    test.fails('t', () => {});\n  });\n});`,
    );
    expect(s.tests[0]!.modifier).toBe('fails');
    expect(s.tests[0]!.modifiers).toEqual([
      { modifier: 'only', loc: { line: 1, col: 1 }, suite: 'outer' },
      { modifier: 'skip', loc: { line: 2, col: 3 }, suite: 'outer > inner' },
      { modifier: 'fails', loc: { line: 3, col: 5 } },
    ]);
  });

  test('a test without any modifier has none', () => {
    expect(
      summarize('a.test.ts', `describe('s', () => { test('t', () => {}); });`).tests[0]!.modifiers,
    ).toBeUndefined();
  });
});

describe('matchers record where they sit in the lattice', () => {
  const m = (source: string) =>
    summarize('a.test.ts', `test('x', () => { ${source} });`).tests[0]!.matchers[0]!;

  test('the argument decides the rank', () => {
    expect(m(`expect(a).toHaveText('x');`)).toMatchObject({
      chain: 'ui-text',
      rank: 0,
      strength: 4,
    });
    expect(m(`expect(a).toHaveText(/x/);`)).toMatchObject({
      chain: 'ui-text',
      rank: 1,
      strength: 3,
    });
    expect(m(`expect(a).toEqual(expect.anything());`)).toMatchObject({
      chain: 'existence',
      rank: 0,
      strength: 1,
    });
  });

  test('an unknown matcher has no placement', () => {
    const use = m(`expect(a).toBeCustom();`);
    expect(use.chain).toBeUndefined();
    expect(use.rank).toBeUndefined();
  });

  test('negation is stored once: an alias is not negated again', () => {
    expect(
      summarize(
        'a.test.ts',
        `import assert from 'node:assert';\ntest('x', () => { assert.notStrictEqual(1, 2); });`,
      ).tests[0]!.matchers[0],
    ).toMatchObject({
      name: 'assert.notStrictEqual',
      negated: true,
    });
  });
});
