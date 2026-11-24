import { describe, expect, test } from 'vitest';
import { SummaryCache, analyzeTestFile } from '../../src/parse/index.js';
import {
  checkIntegrity,
  covers,
  matchTests,
  nameSimilarity,
  parseAllowDirectives,
  weakenedAssertions,
} from '../../src/rules/integrity/index.js';
import { createLattice } from '../../src/rules/lattice.js';
import type { ChangedFile, MatcherUse, TestCase } from '../../src/types.js';

const HEAD = `import { test, describe, expect } from 'vitest';\nimport { add } from './math';\n\n`;
const t = (name: string, body = 'expect(add(1, 2)).toBe(3);') =>
  `test('${name}', () => { ${body} });\n`;

const modified = (before: string, after: string, path = 'a.test.ts'): ChangedFile => ({
  path,
  kind: 'modified',
  before: HEAD + before,
  after: HEAD + after,
});
const check = (changes: ChangedFile[], options = {}) =>
  checkIntegrity(changes, { cwd: '/virtual', exists: () => true, ...options });
const ids = (r: ReturnType<typeof check>) => r.findings.map((f) => f.ruleId);

describe('nameSimilarity', () => {
  test.each([
    ['adds', 'adds', 1],
    ['Adds', 'adds', 1],
    ['', 'x', 0],
    ['abc', 'xyz', 0],
  ])('%s vs %s = %d', (a, b, expected) => {
    expect(nameSimilarity(a, b)).toBe(expected);
  });

  test('close names are above the threshold and unrelated names are below', () => {
    expect(nameSimilarity('adds an item to the cart', 'adds items to the cart')).toBeGreaterThan(
      0.8,
    );
    expect(nameSimilarity('rejects bad input', 'logs on success')).toBeLessThan(0.4);
  });
});

describe('rename detection', () => {
  const tc = (id: string, bodyHash: string, line = 1): TestCase => ({
    id,
    loc: { line, col: 1 },
    matchers: [],
    bodyHash,
  });

  test('same id first, then same body, then similar name', () => {
    const m = matchTests(
      [tc('a', 'h1'), tc('b', 'h2'), tc('adds two numbers', 'h3')],
      [tc('a', 'x'), tc('renamed b', 'h2'), tc('adds two numbers correctly', 'h4')],
    );
    expect(m.pairs.map((p) => [p.before.id, p.after.id, p.via])).toEqual([
      ['a', 'a', 'id'],
      ['b', 'renamed b', 'body'],
      ['adds two numbers', 'adds two numbers correctly', 'name'],
    ]);
    expect(m.removed).toEqual([]);
    expect(m.added).toEqual([]);
  });

  test('matching is one-to-one: two removed tests with the same body need two added ones', () => {
    const m = matchTests([tc('one', 'h'), tc('two', 'h')], [tc('only one left', 'h')]);
    expect(m.pairs).toHaveLength(1);
    expect(m.removed).toHaveLength(1);
  });

  test('a same-id test is never stolen by a body match', () => {
    const m = matchTests([tc('a', 'h'), tc('b', 'h')], [tc('a', 'h'), tc('c', 'zz')], 0.99);
    expect(m.pairs.map((p) => [p.before.id, p.after.id])).toEqual([['a', 'a']]);
    expect(m.removed.map((x) => x.id)).toEqual(['b']);
    expect(m.added.map((x) => x.id)).toEqual(['c']);
  });

  test('the best name wins, and ties go to the test that stayed closest', () => {
    const m = matchTests(
      [tc('handles empty input', 'a', 10)],
      [tc('handles empty input!', 'b', 40), tc('handles empty input?', 'c', 11)],
    );
    expect(m.pairs[0]!.after.id).toBe('handles empty input?');
  });

  test('unrelated names stay removed and added', () => {
    const m = matchTests([tc('rejects bad input', 'a')], [tc('logs on success', 'b')]);
    expect(m.pairs).toEqual([]);
    expect(m.removed).toHaveLength(1);
    expect(m.added).toHaveLength(1);
  });
});

describe('weakenedAssertions', () => {
  const lattice = createLattice();
  /** A matcher as the summary records it: strength and placement come from the lattice. */
  const use = (
    name: string,
    extra: { negated?: boolean; arg?: 'literal' | 'other' | 'none' | 'anything' } = {},
    custom = lattice,
  ): MatcherUse => {
    const r = custom.resolveMatcher({ name, ...extra });
    const m: MatcherUse = { name, strength: r.strength, negated: r.negated, subjectIsMock: false };
    if (r.known && r.chain !== undefined && r.rank !== undefined) {
      m.chain = r.chain;
      m.rank = r.rank;
    }
    return m;
  };

  test('identical assertions cancel out in any order', () => {
    const a = [use('toBe', { arg: 'literal' }), use('toEqual')];
    expect(weakenedAssertions(a, [a[1]!, a[0]!])).toEqual([]);
  });

  test('a dropped assertion is not a weakened one', () => {
    expect(weakenedAssertions([use('toBe'), use('toBeTruthy')], [use('toBe')])).toEqual([]);
  });

  test('a weaker replacement is found even next to unchanged assertions', () => {
    const r = weakenedAssertions([use('toBe'), use('toEqual')], [use('toBe'), use('toBeTruthy')]);
    expect(r.map((c) => [c.from.name, c.to.name])).toEqual([['toEqual', 'toBeTruthy']]);
  });

  test('same matcher: only a real strength drop counts', () => {
    expect(
      weakenedAssertions([use('toBe', { arg: 'literal' })], [use('toBe', { arg: 'other' })]),
    ).toEqual([]);
    expect(
      weakenedAssertions([use('toThrow', { arg: 'other' })], [use('toThrow', { arg: 'none' })]),
    ).toHaveLength(1);
    expect(
      weakenedAssertions([use('toEqual', { arg: 'other' })], [use('toEqual', { arg: 'anything' })]),
    ).toHaveLength(1);
  });

  test('the argument decides where a matcher sits: toHaveText(x) to toContainText(x)', () => {
    const before = use('toHaveText', { arg: 'literal' });
    const after = use('toContainText', { arg: 'literal' });
    expect(weakenedAssertions([before], [after])).toHaveLength(1);
    expect(weakenedAssertions([after], [before])).toEqual([]);
  });

  test('becoming stronger is never weakened, even from an existence check', () => {
    expect(
      weakenedAssertions(
        [use('toEqual', { arg: 'anything' })],
        [use('toMatchObject', { arg: 'other' })],
      ),
    ).toEqual([]);
  });

  test('an alias that is already negated is not negated twice', () => {
    // assert.notStrictEqual is stored as negated; expect(x).not.toBe(y) is the same assertion
    const before = use('assert.notStrictEqual');
    const after = use('toBe', { negated: true, arg: 'literal' });
    expect(before.negated).toBe(true);
    expect(weakenedAssertions([before], [after])).toEqual([]);
    expect(weakenedAssertions([after], [before])).toEqual([]);
  });

  test('positive to negated is weaker, the other way is not', () => {
    expect(weakenedAssertions([use('toEqual')], [use('toEqual', { negated: true })])).toHaveLength(
      1,
    );
    expect(weakenedAssertions([use('toEqual', { negated: true })], [use('toEqual')])).toEqual([]);
  });

  test('unknown matchers are never reported', () => {
    expect(weakenedAssertions([use('toBeCustom')], [use('toBeTruthy')])).toEqual([]);
    expect(weakenedAssertions([use('toEqual')], [use('toBeCustom')])).toEqual([]);
  });

  test('user matcher overrides are honored', () => {
    const custom = createLattice({
      toBeWithin: { like: 'toMatchObject' },
      toBeNear: { strength: 2 },
    });
    expect(
      weakenedAssertions([use('toBeWithin', {}, custom)], [use('toHaveProperty', {}, custom)]),
    ).toHaveLength(1);
    expect(
      weakenedAssertions([use('toBeNear', {}, custom)], [use('toBeTruthy', {}, custom)]),
    ).toHaveLength(1);
  });

  test('aliases are the same assertion: they cancel however they are spelled and ordered', () => {
    const before = [use('toHaveBeenCalledWith'), use('toHaveBeenCalled')];
    const after = [use('toBeCalled'), use('toBeCalledWith')];
    expect(weakenedAssertions(before, after)).toEqual([]);
    expect(weakenedAssertions(after, before)).toEqual([]);
  });

  test('an alias that really is weaker is still found', () => {
    expect(weakenedAssertions([use('toHaveBeenCalledWith')], [use('toBeCalled')])).toHaveLength(1);
  });

  test('negated aliases keep their polarity when they cancel', () => {
    expect(
      weakenedAssertions([use('assert.notEqual')], [use('toEqual', { negated: true })]),
    ).toEqual([]);
    expect(weakenedAssertions([use('assert.equal')], [use('assert.notEqual')])).toHaveLength(1);
  });

  test('assertions recorded without a placement (an old stored summary) are not compared', () => {
    const bare = (name: string, strength: 1 | 2 | 3 | 4): MatcherUse => ({
      name,
      strength,
      negated: false,
      subjectIsMock: false,
    });
    expect(weakenedAssertions([bare('toEqual', 4)], [bare('toBeTruthy', 1)])).toEqual([]);
  });
});

describe('override comments', () => {
  const parse = (src: string) =>
    parseAllowDirectives(analyzeTestFile('a.test.ts', src, { resolve: false }).file);

  test('a rule and a reason', () => {
    expect(
      parse(`// crashdummy-allow integrity/test-removed: API v2 cleanup\nconst a = 1;`),
    ).toMatchObject([
      { rules: ['integrity/test-removed'], reason: 'API v2 cleanup', scope: 'file' },
    ]);
  });

  test('several rules, comma separated', () => {
    expect(
      parse(`const a = 1;\n// crashdummy-allow integrity/a, integrity/b: both fine`)[0],
    ).toMatchObject({
      rules: ['integrity/a', 'integrity/b'],
      reason: 'both fine',
      scope: 'line',
    });
  });

  test.each([
    ['no colon', '// crashdummy-allow integrity/test-removed'],
    ['empty reason', '// crashdummy-allow integrity/test-removed:'],
    ['spaces only', '// crashdummy-allow integrity/test-removed:    '],
    ['punctuation only', '// crashdummy-allow integrity/test-removed: ...'],
  ])('%s is not a reason', (_label, comment) => {
    expect(parse(`${comment}\nconst a = 1;`)[0]).toMatchObject({ reason: undefined });
  });

  test('block comments, with and without star lines', () => {
    expect(parse(`const a = 1;\n/* crashdummy-allow integrity/a: why */`)[0]).toMatchObject({
      reason: 'why',
    });
    expect(
      parse(`const a = 1;\n/**\n * crashdummy-allow integrity/a: because\n */`)[0],
    ).toMatchObject({
      rules: ['integrity/a'],
      reason: 'because',
    });
  });

  test.each([
    '// Example: crashdummy-allow integrity/a: why',
    '// see the docs for crashdummy-allow integrity/a: why',
    '/* we use crashdummy-allow integrity/a: why */',
    '/**\n * Use crashdummy-allow integrity/a: why\n */',
    '// TODO: document crashdummy-allow',
  ])('a comment that only mentions the syntax is not a directive: %s', (comment) => {
    expect(parse(`${comment}\nconst a = 1;`)).toEqual([]);
  });

  test.each([
    '// crashdummy-allow integrity/a: why',
    '//crashdummy-allow integrity/a: why',
    '//    crashdummy-allow integrity/a: why',
    '/* crashdummy-allow integrity/a: why */',
    '/**\n * crashdummy-allow integrity/a: why\n */',
    '/*\n   crashdummy-allow integrity/a: why\n*/',
  ])('a directive may be indented or follow the star of a block comment: %s', (comment) => {
    expect(parse(`${comment}\nconst a = 1;`)).toMatchObject([
      { rules: ['integrity/a'], reason: 'why' },
    ]);
  });

  test('ordinary comments and strings are not directives', () => {
    expect(parse(`// nothing here\nconst s = "crashdummy-allow integrity/a: no";`)).toEqual([]);
  });

  test('a line directive covers its own line and the next line with code, not further', () => {
    const [d] = parse(
      `const a = 1;\n// crashdummy-allow integrity/a: why\n// another comment\n\ntest('x');\ntest('y');`,
    );
    expect(d).toMatchObject({ line: 2, targetLine: 5 });
    expect(covers(d!, 'integrity/a', 5, 'after')).toBe(true);
    expect(covers(d!, 'integrity/a', 2, 'after')).toBe(true);
    expect(covers(d!, 'integrity/a', 6, 'after')).toBe(false);
    expect(covers(d!, 'integrity/b', 5, 'after')).toBe(false);
  });

  test('code after a block comment on the same line is the target', () => {
    const [d] = parse(
      `const a = 1;\n// crashdummy-allow integrity/a: why\n/* note */ test('x');\ntest('y');`,
    );
    expect(d).toMatchObject({ line: 2, targetLine: 3 });
    expect(covers(d!, 'integrity/a', 3, 'after')).toBe(true);
    expect(covers(d!, 'integrity/a', 4, 'after')).toBe(false);
  });

  test('a comment that shares its line with code on both sides targets that line', () => {
    const [d] = parse(
      `const a = 1;\n/* crashdummy-allow integrity/a: why */ test('x');\ntest('y');`,
    );
    expect(d).toMatchObject({ line: 2, targetLine: 2 });
    expect(covers(d!, 'integrity/a', 3, 'after')).toBe(false);
  });

  test('a trailing comment covers its own line only', () => {
    const [d] = parse(`const a = 1;\ntest('x'); // crashdummy-allow integrity/a: why\ntest('y');`);
    expect(d).toMatchObject({ line: 2, targetLine: undefined, scope: 'line' });
    expect(covers(d!, 'integrity/a', 2, 'after')).toBe(true);
    expect(covers(d!, 'integrity/a', 3, 'after')).toBe(false);
  });

  test('a block comment that follows code is trailing too', () => {
    const [d] = parse(
      `const a = 1;\ntest('x'); /* crashdummy-allow integrity/a: why */\ntest('y');`,
    );
    expect(covers(d!, 'integrity/a', 3, 'after')).toBe(false);
  });

  test('comment text inside a string or another comment does not count as code', () => {
    const [d] = parse(
      `const a = 1;\n// crashdummy-allow integrity/a: why\n// ordinary note\n/* another */\n\ntest('x');`,
    );
    expect(d).toMatchObject({ targetLine: 6 });
  });

  test('findings in the old file need a file-level directive', () => {
    const [line] = parse(
      `const a = 1;\n// crashdummy-allow integrity/test-removed: why\ntest('x');`,
    );
    expect(covers(line!, 'integrity/test-removed', 3, 'before')).toBe(false);
    const [file] = parse(`// crashdummy-allow integrity/test-removed: why\nconst a = 1;`);
    expect(covers(file!, 'integrity/test-removed', 9, 'before')).toBe(true);
  });
});

describe('checkIntegrity', () => {
  test('findings are gates with no penalty, and name their file', () => {
    const r = check([modified(t('a') + t('b'), t('a'))]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      ruleId: 'integrity/test-removed',
      layer: 'integrity',
      gate: true,
      severity: 'error',
      evidence: 'strong',
      penalty: 0,
      file: 'a.test.ts',
      message: "test 'b' was removed",
    });
  });

  test('a removed test is reported at its place in the OLD file', () => {
    const r = check([modified(t('a') + '\n\n' + t('b'), t('a'))]);
    expect(r.findings[0]!.loc).toEqual({ line: 7, col: 1 });
  });

  test('an unchanged file has no findings', () => {
    expect(check([modified(t('a'), t('a'))]).findings).toEqual([]);
  });

  test('a new file is only checked for .only', () => {
    const added: ChangedFile = {
      path: 'n.test.ts',
      kind: 'added',
      after: HEAD + t('a') + `test.only('b', () => {});\n`,
    };
    expect(ids(check([added]))).toEqual(['integrity/modifier-added']);
    expect(
      check([{ ...added, after: HEAD + t('a') + `test.skip('b', () => {});\n` }]).findings,
    ).toEqual([]);
  });

  test('one finding for a describe.skip over many tests, naming them', () => {
    const r = check([
      modified(
        `describe('s', () => { ${t('a')} ${t('b')} ${t('c')} ${t('d')} });\n`,
        `describe.skip('s', () => { ${t('a')} ${t('b')} ${t('c')} ${t('d')} });\n`,
      ),
    ]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.message).toBe(
      "4 tests are now skip: 's > a', 's > b', 's > c' (+1 more)",
    );
  });

  test('a skipped test is not also reported as having lost its assertions', () => {
    const r = check([modified(t('a'), `test.skip('a', () => {});\n`)]);
    expect(ids(r)).toEqual(['integrity/modifier-added']);
  });

  test('a test that is weakened and loses assertions is reported by both gates', () => {
    const r = check([
      modified(
        t('a', 'expect(1).toEqual({}); expect(2).toBe(2);'),
        t('a', 'expect(1).toBeTruthy();'),
      ),
    ]);
    expect(ids(r).sort()).toEqual(['integrity/assertions-dropped', 'integrity/matcher-weakened']);
  });

  test('findings come out in file order', () => {
    const r = check([
      modified(t('a') + t('b'), t('a'), 'z.test.ts'),
      modified(t('a') + t('b'), t('a'), 'a.test.ts'),
    ]);
    expect(r.findings.map((f) => f.file)).toEqual(['z.test.ts', 'a.test.ts']);
  });

  test('a custom rule list limits what runs', () => {
    const r = check([modified(t('a') + t('b'), t('a'))], { rules: [] });
    expect(r.findings).toEqual([]);
  });

  test('a file renamed in the change keeps its tests', () => {
    const renamed: ChangedFile = {
      path: 'new.test.ts',
      previousPath: 'old.test.ts',
      kind: 'renamed',
      before: HEAD + t('a') + t('b'),
      after: HEAD + t('a'),
    };
    const r = check([renamed]);
    expect(r.findings[0]).toMatchObject({ ruleId: 'integrity/test-removed', file: 'new.test.ts' });
  });

  test('a source that did not give us the old version is skipped, not guessed', () => {
    const noBefore: ChangedFile = { path: 'a.test.ts', kind: 'modified', after: HEAD + t('a') };
    expect(check([noBefore]).findings).toEqual([]);
  });

  test('a stored TestSummary works as the old version (snapshot mode)', () => {
    const before = analyzeTestFile('a.test.ts', HEAD + t('a') + t('b'), { resolve: false }).summary;
    const r = check([{ path: 'a.test.ts', kind: 'modified', before, after: HEAD + t('a') }]);
    expect(ids(r)).toEqual(['integrity/test-removed']);
  });

  test('the summary cache is used for the old version', () => {
    const cache = new SummaryCache();
    check([modified(t('a') + t('b'), t('a'))], { cache });
    expect(cache.size).toBeGreaterThan(0);
  });
});

describe('suite modifiers', () => {
  const suite = (mod: string, test: string) =>
    `describe${mod}('s', () => { ${test}('a', () => { expect(1).toBe(1); }); ${test}('b', () => { expect(2).toBe(2); }); });\n`;

  test('describe.only over tests that are already skipped is still a .only', () => {
    const r = check([modified(suite('', 'test.skip'), suite('.only', 'test.skip'))]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      ruleId: 'integrity/modifier-added',
      message: "2 tests are now only: 's > a', 's > b'",
    });
  });

  test('describe.skip over tests that carry their own .fails is a skip', () => {
    const r = check([modified(suite('', 'test.fails'), suite('.skip', 'test.fails'))]);
    expect(r.findings.map((f) => f.message)).toEqual(["2 tests are now skip: 's > a', 's > b'"]);
  });

  test('describe.skip over tests that were already skipped adds nothing', () => {
    expect(check([modified(suite('', 'test.skip'), suite('.skip', 'test.skip'))]).findings).toEqual(
      [],
    );
  });

  test('each modifier is reported where it is written: two .skip and one .only are three findings', () => {
    const r = check([modified(suite('', 'test'), suite('.only', 'test.skip'))]);
    expect(r.findings.map((f) => f.message).sort()).toEqual([
      "2 tests are now only: 's > a', 's > b'",
      "test 's > a' is now skip",
      "test 's > b' is now skip",
    ]);
  });

  test('a new test inside a describe.only is a .only', () => {
    const r = check([modified(suite('', 'test'), suite('.only', 'test') + t('fresh'))]);
    expect(r.findings.map((f) => f.ruleId)).toEqual(['integrity/modifier-added']);
  });
});

describe('assertions that are the same under another spelling', () => {
  test('assert.notStrictEqual to expect().not.toBe() is not weaker', () => {
    const r = check([
      {
        path: 'a.test.ts',
        kind: 'modified',
        before: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('x', () => { assert.notStrictEqual(1, 2); });\n`,
        after: `import { test, expect } from 'vitest';\ntest('x', () => { expect(1).not.toBe(2); });\n`,
      },
    ]);
    expect(r.findings).toEqual([]);
  });

  test('toEqual(expect.anything()) to toMatchObject({..}) is stronger, not weaker', () => {
    const r = check([
      modified(
        t('a', 'expect(add(1, 2)).toEqual(expect.anything());'),
        t('a', 'expect(add(1, 2)).toMatchObject({ total: 3 });'),
      ),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('toHaveText(x) to toContainText(x) is weaker', () => {
    const r = check([
      modified(
        t('a', "expect(page).toHaveText('Cart');"),
        t('a', "expect(page).toContainText('Cart');"),
      ),
    ]);
    expect(ids(r)).toEqual(['integrity/matcher-weakened']);
  });
});

describe('a comment that mentions an override', () => {
  test('does not allow anything', () => {
    const r = check([
      modified(
        t('a'),
        `// Example: crashdummy-allow integrity/modifier-added: waiting for a fix\ntest.skip('a', () => { expect(add(1, 2)).toBe(3); });\n`,
      ),
    ]);
    expect(ids(r)).toEqual(['integrity/modifier-added']);
    expect(r.allowed).toEqual([]);
  });
});

describe('matching across files', () => {
  test('an exact body in another file wins over a similar name in the same file', () => {
    const moved = 'expect(add(5, 5)).toBe(10);';
    const r = check([
      modified(t('original', moved), '', 'one.test.ts'),
      modified(
        t('logs on success', 'expect(add(1, 1)).toBe(2);'),
        t('logs on success!', moved),
        'two.test.ts',
      ),
    ]);
    // `original` moved to two.test.ts; it is `logs on success` that is gone
    expect(r.findings.map((f) => [f.file, f.message])).toEqual([
      ['two.test.ts', "test 'logs on success' was removed"],
    ]);
  });

  test('the moved test is compared with the test it really was', () => {
    const moved = 'expect(add(5, 5)).toBe(10);';
    const r = check([
      modified(t('original', moved), '', 'one.test.ts'),
      modified(
        t('logs on success', 'expect(add(1, 1)).toBe(2);'),
        `test.skip('logs on success!', () => { ${moved} });\n`,
        'two.test.ts',
      ),
    ]);
    expect(r.findings.map((f) => f.ruleId).sort()).toEqual([
      'integrity/modifier-added',
      'integrity/test-removed',
    ]);
  });
});

describe('names are compared by title, not by suite', () => {
  const inSuite = (name: string, body: string) =>
    `describe('shopping cart checkout flow', () => { ${t(name, body)} });\n`;

  test('unrelated tests under one long suite name are not a rename', () => {
    const r = check([
      modified(
        inSuite('rejects bad input', 'expect(add(1, 2)).toBe(3);'),
        inSuite('logs on success', 'expect(add(2, 2)).toBe(4);'),
      ),
    ]);
    expect(r.findings.map((f) => f.message)).toEqual([
      "test 'shopping cart checkout flow > rejects bad input' was removed",
    ]);
  });

  test('a renamed test in the same suite is still found by its title', () => {
    const r = check([
      modified(
        inSuite('adds two numbers', 'expect(add(1, 2)).toBe(3);'),
        inSuite('adds two numbers correctly', 'expect(add(2, 2)).toBe(4);'),
      ),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('a test that moved to another suite keeps its title', () => {
    const r = check([
      modified(
        `describe('old suite', () => { ${t('adds two numbers', 'expect(add(1, 2)).toBe(3);')} });\n`,
        `describe('a very different suite name', () => { ${t('adds two numbers correctly', 'expect(add(2, 2)).toBe(4);')} });\n`,
      ),
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('imports that are not code', () => {
  const withAsset: ChangedFile = {
    path: 'a.test.ts',
    kind: 'modified',
    before: `import { test, expect } from 'vitest';\nimport data from './data.json';\n${t('a')}${t('b')}`,
    after: `import { test, expect } from 'vitest';\n${t('a')}`,
  };

  test('an asset is not the code under test: a removal next to one is still reported', () => {
    const r = check([withAsset], { exists: (p: string) => p.endsWith('data.json') });
    expect(ids(r)).toEqual(['integrity/test-removed']);
  });

  test('a JS or TS import next to an asset still decides', () => {
    const both: ChangedFile = {
      ...withAsset,
      before: (withAsset.before as string).replace(
        'import data',
        "import { add } from './math.js';\nimport data",
      ),
    };
    expect(check([both], { exists: () => false }).findings).toEqual([]);
    expect(ids(check([both], { exists: (p: string) => p.includes('math') }))).toEqual([
      'integrity/test-removed',
    ]);
  });

  test.each(['./styles.css', './logo.svg', './fixture.yaml', './query.graphql'])('%s', (asset) => {
    const f: ChangedFile = {
      ...withAsset,
      before: (withAsset.before as string).replace('./data.json', asset),
    };
    expect(ids(check([f], { exists: () => false }))).toEqual(['integrity/test-removed']);
  });
});

describe('negated assertions', () => {
  test('two negated assertions are not ranked against each other', () => {
    const r = check([
      modified(
        t('a', 'expect(add(1, 2)).not.toEqual({ a: 1, b: 2 });'),
        t('a', 'expect(add(1, 2)).not.toMatchObject({ a: 1 });'),
      ),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('going from positive to negated is still weaker', () => {
    const r = check([
      modified(
        t('a', 'expect(add(1, 2)).toEqual({ a: 1 });'),
        t('a', 'expect(add(1, 2)).not.toEqual({ b: 1 });'),
      ),
    ]);
    expect(ids(r)).toEqual(['integrity/matcher-weakened']);
  });
});

describe('a suite skip and the other gates', () => {
  const suite = (mod: string, test: string, body: string) =>
    `describe${mod}('s', () => { ${test}('a', () => { ${body} }); });\n`;

  test('a test with its own fails under a skipped describe is reported once, by the skip', () => {
    const r = check([
      modified(
        suite('', 'test.fails', 'expect(1).toBe(2); expect(2).toBe(3);'),
        suite('.skip', 'test.fails', 'expect(1).toBe(2);'),
      ),
    ]);
    expect(ids(r)).toEqual(['integrity/modifier-added']);
  });

  test('a reasoned override on the skip is then enough', () => {
    const allowed = `// crashdummy-allow integrity/modifier-added: waiting on the API fix\n${suite('.skip', 'test.fails', 'expect(1).toBe(2);')}`;
    const r = check([
      modified(suite('', 'test.fails', 'expect(1).toBe(2); expect(2).toBe(3);'), allowed),
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('where a focus was written', () => {
  const suite = (mod: string, tests: string) => `describe${mod}('s', () => { ${tests} });\n`;

  test('test.only added under an unchanged describe.only is a new focus', () => {
    const r = check([
      modified(
        suite('.only', t('a') + t('b')),
        suite('.only', `test.only('a', () => { expect(add(1, 2)).toBe(3); });\n` + t('b')),
      ),
    ]);
    expect(r.findings.map((f) => f.message)).toEqual(["test 's > a' is now only"]);
  });

  test('a new test under an unchanged describe.only is not', () => {
    expect(
      check([modified(suite('.only', t('a')), suite('.only', t('a') + t('b')))]).findings,
    ).toEqual([]);
  });

  test('an unchanged describe.only over unchanged tests is not', () => {
    expect(
      check([modified(suite('.only', t('a') + t('b')), suite('.only', t('a') + t('b')))]).findings,
    ).toEqual([]);
  });

  test('a describe.only that is new is, however many tests it holds', () => {
    const r = check([
      modified(suite('', t('a') + t('b')), suite('.only', t('a') + t('b') + t('c'))),
    ]);
    expect(r.findings.map((f) => f.message)).toEqual([
      "3 tests are now only: 's > a', 's > b', 's > c'",
    ]);
  });

  test('a test.only that was already there is not new', () => {
    const only = `test.only('a', () => { expect(add(1, 2)).toBe(3); });\n`;
    expect(check([modified(only, only)]).findings).toEqual([]);
  });
});

describe('matching does not depend on the order of the files', () => {
  const body = 'expect(add(5, 5)).toBe(10);';
  // a.test.ts deletes a test; b.test.ts renames one that has the very same body
  const deletes = modified(
    t('gone', body) + t('keep', 'expect(1).toBe(1);'),
    t('keep', 'expect(1).toBe(1);'),
    'a.test.ts',
  );
  const renames = modified(t('old name', body), t('new name', body), 'b.test.ts');

  test.each([
    ['deleting file first', [deletes, renames]],
    ['renaming file first', [renames, deletes]],
  ])('%s', (_label, files) => {
    const r = check(files);
    expect(r.findings.map((f) => [f.file, f.message])).toEqual([
      ['a.test.ts', "test 'gone' was removed"],
    ]);
  });

  test('a rename inside a file is never taken by another file', () => {
    const r = check([renames, deletes]);
    expect(r.findings.some((f) => f.file === 'b.test.ts')).toBe(false);
  });
});

describe('every new place that switches a test off or focuses it is reported', () => {
  test("describe.only and the test's own .only are two findings, so one override cannot hide both", () => {
    const r = check([
      modified(
        `describe('s', () => { ${t('a')} });\n`,
        `describe.only('s', () => { test.only('a', () => { expect(add(1, 2)).toBe(3); }); });\n`,
      ),
    ]);
    expect(r.findings.map((f) => f.message).sort()).toEqual([
      "test 's > a' is now only",
      "test 's > a' is now only",
    ]);
    expect(new Set(r.findings.map((f) => `${f.loc!.line}:${f.loc!.col}`)).size).toBe(2);
  });

  test("an override on the suite leaves the test's own focus reported", () => {
    const after = `// crashdummy-allow integrity/modifier-added: focusing while I debug\ndescribe.only('s', () => {\n  test.only('a', () => { expect(add(1, 2)).toBe(3); });\n});\n`;
    const r = check([modified(`describe('s', () => { ${t('a')} });\n`, after)]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.loc).toEqual({ line: 6, col: 3 });
    expect(r.allowed).toHaveLength(1);
  });

  test('the same goes for skips', () => {
    const r = check([
      modified(
        `describe('s', () => { ${t('a')} });\n`,
        `describe.skip('s', () => { test.skip('a', () => { expect(add(1, 2)).toBe(3); }); });\n`,
      ),
    ]);
    expect(r.findings).toHaveLength(2);
  });

  test('a test that was already switched off gains nothing from another reason', () => {
    const r = check([
      modified(
        `describe('s', () => { test.skip('a', () => { expect(1).toBe(1); }); });\n`,
        `describe.skip('s', () => { test.skip('a', () => { expect(1).toBe(1); }); });\n`,
      ),
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('a suite that is renamed is the same suite', () => {
  const suite = (name: string, mod: string, tests: string) =>
    `describe${mod}('${name}', () => { ${tests} });\n`;

  test('describe.only kept through a rename is not a new focus', () => {
    expect(
      check([modified(suite('math', '.only', t('a')), suite('arithmetic', '.only', t('a')))])
        .findings,
    ).toEqual([]);
  });

  test('nor when a child is added during the rename', () => {
    expect(
      check([
        modified(suite('math', '.only', t('a')), suite('arithmetic', '.only', t('a') + t('b'))),
      ]).findings,
    ).toEqual([]);
  });

  test('a describe.only one level further in is still new', () => {
    const r = check([
      modified(
        suite('math', '.only', t('a')),
        suite('math', '.only', `describe.only('inner', () => { ${t('a')} });\n`),
      ),
    ]);
    expect(r.findings.map((f) => f.ruleId)).toEqual(['integrity/modifier-added']);
  });

  test('a focus on a different suite is new', () => {
    const r = check([
      modified(
        suite('a', '', t('x')) + suite('b', '.only', t('y')),
        suite('a', '.only', t('x')) + suite('b', '', t('y')),
      ),
    ]);
    expect(r.findings.map((f) => f.message)).toEqual(["test 'a > x' is now only"]);
  });
});

describe('tests that share a title', () => {
  const two = (a: string, b: string) => `${t('x', a)}${t('x', b)}`;

  test('swapping them is not a change', () => {
    const r = check([
      modified(
        two('expect(1).toEqual(1);', 'expect(2).toBeTruthy();'),
        two('expect(2).toBeTruthy();', 'expect(1).toEqual(1);'),
      ),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('removing one reports the one that is gone, whichever it was', () => {
    const r = check([
      modified(
        two('expect(1).toEqual(1);', 'expect(2).toBeTruthy();'),
        t('x', 'expect(2).toBeTruthy();'),
      ),
    ]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      ruleId: 'integrity/test-removed',
      message: "test 'x' was removed",
    });
    expect(r.findings[0]!.loc).toEqual({ line: 4, col: 1 }); // the first one, `toEqual`
  });

  test('weakening one of them is still found', () => {
    const r = check([
      modified(
        two('expect(1).toEqual(1);', 'expect(2).toBe(2);'),
        two('expect(1).toBeTruthy();', 'expect(2).toBe(2);'),
      ),
    ]);
    expect(r.findings.map((f) => f.ruleId)).toEqual(['integrity/matcher-weakened']);
  });

  test('adding a duplicate is not a removal', () => {
    expect(check([modified(t('x'), t('x') + t('x', 'expect(3).toBe(3);'))]).findings).toEqual([]);
  });

  test('tests that merely end in a number are not treated as repeats', () => {
    expect(
      check([modified(t('case #2') + t('case #3'), t('case #3') + t('case #2'))]).findings,
    ).toEqual([]);
  });
});

describe('hiding tests from the runner', () => {
  test('wrapping every test in a function that is never called is a removal', () => {
    const r = check([modified(t('a') + t('b'), `function all() { ${t('a')} ${t('b')} }\n`)]);
    expect(ids(r)).toEqual(['integrity/test-removed', 'integrity/test-removed']);
  });

  test('calling that function again keeps the tests, so it is only a refactor', () => {
    const r = check([
      modified(t('a') + t('b'), `function all() { ${t('a')} ${t('b')} }\nall();\n`),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('tests moved into a describe through a named function keep their place', () => {
    const r = check([
      modified(t('a'), `function register() { ${t('a')} }\ndescribe('s', register);\n`),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('moving a weakened test into an uncalled function does not hide the weakening', () => {
    const r = check([
      modified(
        t('a', 'expect(1).toEqual({});'),
        `function all() { ${t('a', 'expect(1).toBeTruthy();')} }\nall();\n`,
      ),
    ]);
    expect(ids(r)).toEqual(['integrity/matcher-weakened']);
  });
});

describe('a test file that was deleted', () => {
  const deleted = (before: string, path = 'a.test.ts'): ChangedFile => ({
    path,
    kind: 'deleted',
    before: HEAD + before,
  });

  test('is a removal of every test while the code under test still exists', () => {
    const r = check([deleted(t('a') + t('b'))]);
    expect(ids(r)).toEqual(['integrity/test-removed', 'integrity/test-removed']);
  });

  test('is not, when the code it tested was deleted with it', () => {
    const r = check([deleted(t('a') + t('b'))], { exists: () => false });
    expect(r.findings).toEqual([]);
  });

  test('looks at the module the old file imported, relative to the old file', () => {
    const seen: string[] = [];
    check([deleted(t('a'), 'src/cart/cart.test.ts')], {
      cwd: '/repo',
      exists: (p: string) => (seen.push(p), false),
    });
    expect(seen.some((p) => p.startsWith('/repo/src/cart/math'))).toBe(true);
  });

  test('a test that imported no local module has nothing to check, so it is reported', () => {
    const noImports: ChangedFile = {
      path: 'a.test.ts',
      kind: 'deleted',
      before: `import { test, expect } from 'vitest';\n${t('a', 'expect(1).toBe(1);')}`,
    };
    expect(ids(check([noImports], { exists: () => false }))).toEqual(['integrity/test-removed']);
  });

  test('a package whose name ends in .js is not a local file that disappeared', () => {
    const packagesOnly: ChangedFile = {
      path: 'a.test.ts',
      kind: 'modified',
      before: `import { test, expect } from 'vitest';\nimport isEqual from 'lodash/isEqual.js';\n${t('a')}${t('b')}`,
      after: `import { test, expect } from 'vitest';\n${t('a')}`,
    };
    expect(ids(check([packagesOnly], { exists: () => false }))).toEqual(['integrity/test-removed']);
  });

  test('a stored summary holds repo paths, and those are checked directly', () => {
    const before = analyzeTestFile('a.test.ts', HEAD + t('a') + t('b'), {
      resolve: { cwd: '/virtual', exists: () => true },
    }).summary;
    expect(before.imports).toEqual(['math.ts']);
    const seen: string[] = [];
    const gone = check([{ path: 'a.test.ts', kind: 'modified', before, after: HEAD + t('a') }], {
      exists: (p: string) => (seen.push(p), false),
    });
    expect(gone.findings).toEqual([]); // the module is gone, so removing its tests is fine
    expect(seen).toContain('/virtual/math.ts');
    expect(
      ids(check([{ path: 'a.test.ts', kind: 'modified', before, after: HEAD + t('a') }])),
    ).toEqual(['integrity/test-removed']);
  });

  test('removing tests from a file that stays is judged the same way', () => {
    const r = check([modified(t('a') + t('b'), t('a'))], { exists: () => false });
    expect(r.findings).toEqual([]);
  });

  test('can only be allowed with an option: there is no comment left to write', () => {
    const r = check([deleted(t('a'))], {
      allow: [
        { rule: 'integrity/test-removed', file: 'a.test.ts', reason: 'moved to another repo' },
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.allowed).toMatchObject([{ source: 'option', reason: 'moved to another repo' }]);
  });
});

describe('a test moved to another file', () => {
  test('is not a removal when its body is identical', () => {
    const r = check([
      modified(t('a') + t('moves', 'expect(add(5, 5)).toBe(10);'), t('a'), 'one.test.ts'),
      modified(t('x'), t('x') + t('moves elsewhere', 'expect(add(5, 5)).toBe(10);'), 'two.test.ts'),
    ]);
    expect(r.findings).toEqual([]);
  });

  test('is a removal when the body changed', () => {
    const r = check([
      modified(t('a') + t('moves', 'expect(add(5, 5)).toBe(10);'), t('a'), 'one.test.ts'),
      modified(t('x'), t('x') + t('moves elsewhere', 'expect(1).toBeTruthy();'), 'two.test.ts'),
    ]);
    expect(ids(r)).toEqual(['integrity/test-removed']);
  });

  test('it is still judged: moved and skipped is a skip, moved and weakened is weakened', () => {
    const body = 'expect(add(5, 5)).toBe(10);';
    const skipped = check([
      modified(t('a') + t('moves', body), t('a'), 'one.test.ts'),
      modified(t('x'), t('x') + `test.skip('moved', () => { ${body} });\n`, 'two.test.ts'),
    ]);
    expect(skipped.findings.map((f) => [f.file, f.ruleId])).toEqual([
      ['two.test.ts', 'integrity/modifier-added'],
    ]);

    const focused = check([
      modified(t('a') + t('moves', body), t('a'), 'one.test.ts'),
      modified(t('x'), t('x') + `test.only('moved', () => { ${body} });\n`, 'two.test.ts'),
    ]);
    expect(focused.findings.map((f) => f.ruleId)).toEqual(['integrity/modifier-added']);
  });

  test('one added test cannot cover two removed ones', () => {
    const body = 'expect(add(5, 5)).toBe(10);';
    const r = check([
      modified(t('a', body) + t('b', body), '', 'one.test.ts'),
      modified('', t('c', body), 'two.test.ts'),
    ]);
    expect(ids(r)).toEqual(['integrity/test-removed']);
  });
});

describe('overrides', () => {
  test('allowed findings are returned with their reason, not dropped', () => {
    const r = check([
      modified(
        t('a'),
        `// crashdummy-allow integrity/modifier-added: waiting on the API fix\ntest.skip('a', () => { expect(add(1, 2)).toBe(3); });\n`,
      ),
    ]);
    expect(r.findings).toEqual([]);
    expect(r.allowed).toHaveLength(1);
    expect(r.allowed[0]).toMatchObject({
      source: 'comment',
      reason: 'waiting on the API fix',
      finding: { ruleId: 'integrity/modifier-added' },
    });
  });

  test('a directive with no reason does not allow, and is a gate itself', () => {
    const r = check([
      modified(
        t('a'),
        `// crashdummy-allow integrity/modifier-added\ntest.skip('a', () => { expect(add(1, 2)).toBe(3); });\n`,
      ),
    ]);
    expect(ids(r).sort()).toEqual(['integrity/allow-without-reason', 'integrity/modifier-added']);
    expect(r.findings.find((f) => f.ruleId === 'integrity/allow-without-reason')).toMatchObject({
      gate: true,
    });
    expect(r.allowed).toEqual([]);
  });

  test('an unknown integrity rule is a warning, not a gate', () => {
    const r = check([modified(t('a'), t('a') + `// crashdummy-allow integrity/nope: why\n`)]);
    expect(r.findings).toMatchObject([
      { ruleId: 'integrity/allow-unknown-rule', gate: false, severity: 'warn' },
    ]);
  });

  test('rules from other layers are left to their own layer', () => {
    const r = check([modified(t('a'), t('a') + `// crashdummy-allow oracle/weak-matcher: why\n`)]);
    expect(r.findings).toEqual([]);
  });

  test('a directive with no rule is reported', () => {
    const r = check([modified(t('a'), t('a') + `// crashdummy-allow: why\n`)]);
    expect(ids(r)).toContain('integrity/allow-unknown-rule');
  });

  test('an option without a real reason allows nothing', () => {
    const r = check([modified(t('a') + t('b'), t('a'))], {
      allow: [{ rule: 'integrity/test-removed', reason: '-' }],
    });
    expect(ids(r)).toEqual(['integrity/test-removed']);
  });

  test('an option for one file does not cover another', () => {
    const r = check([modified(t('a') + t('b'), t('a'), 'one.test.ts')], {
      allow: [{ rule: 'integrity/test-removed', file: 'other.test.ts', reason: 'fine' }],
    });
    expect(ids(r)).toEqual(['integrity/test-removed']);
  });
});

describe('files that do not parse', () => {
  const broken = HEAD + `test('a', () => { expect(1).toBe(1); });\nconst = ;\n`;

  test('fail mode (the default): a gate, and no comparison, so no "removed" findings', () => {
    const r = check([
      { path: 'a.test.ts', kind: 'modified', before: HEAD + t('a') + t('b'), after: broken },
    ]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      ruleId: 'integrity/unparseable',
      gate: true,
      severity: 'error',
      loc: { line: 5, col: 7 },
    });
    expect(r.findings[0]!.message).toContain('line 5: Unexpected token');
  });

  test('warn mode: a warning, not a gate', () => {
    const r = check(
      [{ path: 'a.test.ts', kind: 'modified', before: HEAD + t('a') + t('b'), after: broken }],
      { onParseError: 'warn' },
    );
    expect(r.findings).toMatchObject([
      { ruleId: 'integrity/unparseable', gate: false, severity: 'warn' },
    ]);
  });

  test('an unparseable old version is a note: the new tests are treated as new', () => {
    const r = check([
      {
        path: 'a.test.ts',
        kind: 'modified',
        before: broken,
        after: HEAD + t('a') + `test.only('b', () => {});\n`,
      },
    ]);
    expect(r.findings.map((f) => [f.ruleId, f.gate])).toEqual([
      ['integrity/unparseable-before', false],
      ['integrity/modifier-added', true],
    ]);
  });

  test('both sides unparseable: one finding, for the new file only', () => {
    const r = check([{ path: 'a.test.ts', kind: 'modified', before: broken, after: broken }]);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.filter((f) => f.gate)).toHaveLength(1);
  });

  test('the other files in the same change are still checked', () => {
    const r = check([
      { path: 'bad.test.ts', kind: 'modified', before: HEAD + t('a'), after: broken },
      modified(t('a') + t('b'), t('a'), 'good.test.ts'),
    ]);
    expect(r.findings.map((f) => [f.file, f.ruleId])).toEqual([
      ['bad.test.ts', 'integrity/unparseable'],
      ['good.test.ts', 'integrity/test-removed'],
    ]);
  });
});
