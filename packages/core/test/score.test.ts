import { describe, expect, test } from 'vitest';
import { score, staticScore, suiteScore, verdictOf, exitCodeOf, EXIT } from '../src/score/index.js';
import { parseConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import type { ChangedFile, FileScore, Finding } from '../src/types.js';

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'oracle/no-assertion',
  layer: 'oracle',
  gate: false,
  evidence: 'strong',
  severity: 'warn',
  file: 'a.test.ts',
  message: 'm',
  penalty: 15,
  ...over,
});

describe('staticScore', () => {
  test('no findings is 100', () => {
    expect(staticScore([], 4)).toBe(100);
  });

  test('penalties are averaged over the tests, so file size does not change the score', () => {
    const one = [finding({ test: 't1' })];
    expect(staticScore(one, 1)).toBe(85);
    expect(staticScore(one, 10)).toBe(99); // 100 - 1.5, rounded
    // same share of bad tests, same score, whatever the size
    const two = [finding({ test: 't1' }), finding({ test: 't2' })];
    expect(staticScore(two, 4)).toBe(staticScore([finding({ test: 't1' })], 2));
  });

  test('a finding about the whole file counts in full', () => {
    expect(staticScore([finding()], 10)).toBe(85);
  });

  test('a rule cannot remove more than its cap', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      finding({ test: 't', ruleId: 'r', penalty: 20 + i }),
    );
    expect(staticScore(many, 1, new Map([['r', 30]]))).toBe(70);
  });

  test('rules add up, and the score never goes below 0', () => {
    const f = [finding({ ruleId: 'a', penalty: 60 }), finding({ ruleId: 'b', penalty: 60 })];
    expect(staticScore(f, 1)).toBe(0);
    expect(
      staticScore([finding({ ruleId: 'a', penalty: 10 }), finding({ ruleId: 'b', penalty: 5 })], 1),
    ).toBe(85);
  });

  test('a finding with no penalty changes nothing', () => {
    expect(staticScore([finding({ penalty: 0, gate: true })], 3)).toBe(100);
  });

  test('the result is an integer', () => {
    expect(Number.isInteger(staticScore([finding({ test: 't' })], 7))).toBe(true);
  });
});

describe('verdict and exit codes', () => {
  const file = (over: Partial<FileScore> = {}): FileScore => ({
    file: 'a.test.ts',
    status: 'scored',
    score: 90,
    findings: [],
    subscores: { static: 90, coverage: 'unknown', mutation: 'unknown' },
    confidence: 'static-estimate',
    gates: [],
    ...over,
  });

  test('pass, warn, fail', () => {
    expect(verdictOf([file()])).toBe('pass');
    expect(verdictOf([file({ findings: [finding()] })])).toBe('warn');
    expect(verdictOf([file({ findings: [finding()], gates: [finding({ gate: true })] })])).toBe(
      'fail',
    );
  });

  test('an info finding never changes the verdict', () => {
    expect(verdictOf([file({ findings: [finding({ severity: 'info', penalty: 0 })] })])).toBe(
      'pass',
    );
  });

  test('a score below minScore fails, at it passes', () => {
    expect(verdictOf([file({ score: 49 })])).toBe('fail');
    expect(verdictOf([file({ score: 50 })])).toBe('pass');
    expect(verdictOf([file({ score: 60 })], { minScore: 65 })).toBe('fail');
  });

  test('a file with no score is neither below nor above minScore', () => {
    expect(verdictOf([file({ status: 'unparseable', score: undefined as never })])).toBe('pass');
  });

  test('exit codes are stable', () => {
    expect([EXIT.pass, EXIT.fail, EXIT.warn, EXIT.error]).toEqual([0, 1, 2, 3]);
    expect(exitCodeOf('pass')).toBe(0);
    expect(exitCodeOf('fail')).toBe(1);
    expect(exitCodeOf('warn')).toBe(0);
    expect(exitCodeOf('warn', true)).toBe(2);
    expect(exitCodeOf('pass', true)).toBe(0);
  });
});

describe('suiteScore', () => {
  test('weighted by test count; files without a score are left out, not counted as 0', () => {
    expect(
      suiteScore([
        { score: 100, tests: 1 },
        { score: 50, tests: 3 },
      ]),
    ).toBe(63);
    expect(suiteScore([{ score: 80, tests: 2 }, { tests: 9 }])).toBe(80);
    expect(suiteScore([{ tests: 2 }])).toBeUndefined();
  });
});

const added = (path: string, after: string): ChangedFile => ({ path, kind: 'added', after });
const T = `import { test, expect } from 'vitest';\nimport { f } from './f.js';\n`;

describe('score()', () => {
  const run = (changes: ChangedFile[], options = {}) =>
    score(changes, { cwd: '/nonexistent', ...options });

  test('a clean file passes with 100', async () => {
    const r = await run([
      added('a.test.ts', `${T}test('x', () => { expect(f()).toEqual({ a: 1 }); });`),
    ]);
    expect(r).toMatchObject({ version: 1, tiersRun: [0], verdict: 'pass', suite: { score: 100 } });
    expect(r.files[0]).toMatchObject({
      status: 'scored',
      score: 100,
      confidence: 'static-estimate',
      subscores: { static: 100, coverage: 'unknown', mutation: 'unknown' },
    });
  });

  test('a gate fails the check even when the score is high, outside the score', async () => {
    const tests = Array.from(
      { length: 9 },
      (_, i) => `test('ok ${i}', () => { expect(f()).toEqual({ a: 1 }); });`,
    );
    const r = await run([
      added('a.test.ts', `${T}${tests.join('\n')}\ntest('none', () => { f(); });`),
    ]);
    expect(r.verdict).toBe('fail');
    expect(r.files[0]!.score).toBeGreaterThan(95);
    expect(r.files[0]!.gates.map((g) => g.ruleId)).toEqual(['oracle/no-assertion']);
  });

  test('a warning alone is a warn verdict', async () => {
    const r = await run([
      added('a.test.ts', `${T}test('x', () => { expect(f()).toBeTruthy(); });`),
    ]);
    expect(r.verdict).toBe('warn');
    expect(r.files[0]!.gates).toEqual([]);
  });

  test('an unparseable file gets no score and is not in the suite', async () => {
    const r = await run([
      added('bad.test.ts', 'test('),
      added('ok.test.ts', `${T}test('x', () => { expect(f()).toEqual(1); });`),
    ]);
    const bad = r.files.find((f) => f.file === 'bad.test.ts')!;
    expect(bad.status).toBe('unparseable');
    expect(bad.score).toBeUndefined();
    expect(bad.error).toMatchObject({ line: 1 });
    expect(r.suite?.score).toBe(100);
    expect(r.verdict).toBe('fail'); // fail mode by default
  });

  test('onParseError "warn" makes it a warning', async () => {
    const r = await run([added('bad.test.ts', 'test(')], { onParseError: 'warn' });
    expect(r.verdict).toBe('warn');
    expect(r.suite).toBeUndefined();
  });

  test('minScore fails a low file', async () => {
    const src = `${T}test('x', () => { expect(f()).toBeTruthy(); });`;
    expect((await run([added('a.test.ts', src)], { minScore: 99 })).verdict).toBe('fail');
    expect((await run([added('a.test.ts', src)], { minScore: 90 })).verdict).toBe('warn');
  });

  test('a rule can be turned off, or given another penalty', async () => {
    const src = `${T}test('x', () => { expect(f()).toBeTruthy(); });`;
    const off = await run([added('a.test.ts', src)], { rules: { 'oracle/weak-matcher': 'off' } });
    expect(off.verdict).toBe('pass');
    const pen = await run([added('a.test.ts', src)], {
      rules: { 'oracle/weak-matcher': { penalty: 10 } },
    });
    expect(pen.files[0]!.score).toBe(90);
  });

  test('unknown matchers are reported as info and change nothing', async () => {
    const r = await run([
      added(
        'a.test.ts',
        `${T}test('x', () => { expect(f()).toBeWithinRange(1, 2); expect(f()).toEqual(1); });`,
      ),
    ]);
    expect(r.unknownMatchers).toEqual([
      { name: 'toBeWithinRange', count: 1, files: ['a.test.ts'] },
    ]);
    expect(r.files[0]!.findings.map((x) => x.ruleId)).toContain('info/unknown-matcher');
    expect(r.verdict).toBe('pass');
    expect(r.files[0]!.score).toBe(100);
  });

  test('a matcher the user configured is not unknown', async () => {
    const r = await run(
      [added('a.test.ts', `${T}test('x', () => { expect(f()).toBeWithinRange(1, 2); });`)],
      { matchers: { toBeWithinRange: { strength: 3 } } as never },
    );
    expect(r.unknownMatchers).toBeUndefined();
  });

  test('a custom assertion helper is not an unknown matcher', async () => {
    const r = await run(
      [
        added(
          'a.test.ts',
          `${T}import { expectOk } from './h.js';\ntest('x', () => { expectOk(f()); });`,
        ),
      ],
      { assertFunctionNames: ['expectOk'] },
    );
    expect(r.unknownMatchers).toBeUndefined();
  });

  test('a deleted file has findings but no score', async () => {
    const r = await run([
      {
        path: 'gone.test.ts',
        kind: 'deleted',
        before: `${T}test('x', () => { expect(f()).toEqual(1); });`,
      },
    ]);
    expect(r.files[0]).toMatchObject({ status: 'deleted' });
    expect(r.files[0]!.score).toBeUndefined();
  });

  test('weakening an assertion is a gate', async () => {
    const before = `${T}test('x', () => { expect(f()).toEqual({ a: 1 }); });`;
    const after = `${T}test('x', () => { expect(f()).toBeTruthy(); });`;
    const r = await run([{ path: 'a.test.ts', kind: 'modified', before, after }]);
    expect(r.verdict).toBe('fail');
    expect(r.files[0]!.gates.map((g) => g.ruleId)).toContain('integrity/matcher-weakened');
  });
});

describe('config', () => {
  test('valid config', () => {
    expect(
      parseConfig({
        minScore: 65,
        onParseError: 'warn',
        assertFunctionNames: ['expectOk'],
        rules: { 'a/b': 'off', 'c/d': { penalty: 3 } },
      }),
    ).toMatchObject({ minScore: 65, onParseError: 'warn' });
  });

  test.each([
    [{ minScor: 1 }, /unknown config key "minScor"/],
    [{ minScore: 101 }, /minScore/],
    [{ minScore: 1.5 }, /minScore/],
    [{ onParseError: 'ignore' }, /onParseError/],
    [{ testGlobs: 'x' }, /testGlobs/],
    [{ rules: { a: 'maybe' } }, /rules\.a/],
    [{ rules: { a: { penalty: -1 } } }, /rules\.a/],
    [[], /JSON object/],
  ])('rejects %j', (input, message) => {
    expect(() => parseConfig(input)).toThrow(ConfigError);
    expect(() => parseConfig(input)).toThrow(message);
  });
});
