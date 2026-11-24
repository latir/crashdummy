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
  const use = (name: string, strength: MatcherUse['strength'], negated = false): MatcherUse => ({
    name,
    strength,
    negated,
    subjectIsMock: false,
  });

  test('identical assertions cancel out in any order', () => {
    const a = [use('toBe', 4), use('toEqual', 4)];
    expect(weakenedAssertions(a, [a[1]!, a[0]!], lattice)).toEqual([]);
  });

  test('a dropped assertion is not a weakened one', () => {
    expect(
      weakenedAssertions([use('toBe', 4), use('toBeTruthy', 1)], [use('toBe', 4)], lattice),
    ).toEqual([]);
  });

  test('a weaker replacement is found even next to unchanged assertions', () => {
    const r = weakenedAssertions(
      [use('toBe', 4), use('toEqual', 4)],
      [use('toBe', 4), use('toBeTruthy', 1)],
      lattice,
    );
    expect(r.map((c) => [c.from.name, c.to.name])).toEqual([['toEqual', 'toBeTruthy']]);
  });

  test('same matcher: only a real strength drop counts', () => {
    expect(weakenedAssertions([use('toBe', 4)], [use('toBe', 3)], lattice)).toEqual([]);
    expect(weakenedAssertions([use('toThrow', 3)], [use('toThrow', 2)], lattice)).toHaveLength(1);
    expect(weakenedAssertions([use('toEqual', 4)], [use('toEqual', 1)], lattice)).toHaveLength(1);
  });

  test('unknown matchers are never reported', () => {
    expect(weakenedAssertions([use('toBeCustom', 2)], [use('toBeTruthy', 1)], lattice)).toEqual([]);
  });

  test('user matcher overrides are honored', () => {
    const custom = createLattice({
      toBeWithin: { like: 'toMatchObject' },
      toBeNear: { strength: 2 },
    });
    expect(
      weakenedAssertions([use('toBeWithin', 3)], [use('toHaveProperty', 3)], custom),
    ).toHaveLength(1);
    expect(weakenedAssertions([use('toBeNear', 2)], [use('toBeTruthy', 1)], custom)).toHaveLength(
      1,
    );
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
