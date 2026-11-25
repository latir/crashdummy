import { describe, expect, test } from 'vitest';
import { analyzeTestFile } from '../src/parse/index.js';
import { checkOracle, oracleRules } from '../src/rules/oracle/index.js';

const run = (src: string, options = {}, file = 'a.test.ts') =>
  checkOracle(file, src, { resolve: false, ...options });

describe('rule metadata follows the plan', () => {
  const meta = Object.fromEntries(oracleRules.map((r) => [r.id, r.meta]));

  test('penalty, cap and gate', () => {
    const table = Object.entries(meta).map(([id, m]) => [id, m.penalty, m.cap, m.gate]);
    expect(table).toEqual([
      ['oracle/no-assertion', 15, 30, true],
      ['oracle/tautological-assertion', 15, 30, true],
      ['oracle/swallowed-async', 10, 20, true],
      // gate once precision is measured (CD-6): full mocks only
      ['oracle/mocks-subject', 15, 30, false],
      ['oracle/tautological-mock', 12, 24, false],
      ['oracle/weak-matcher', 5, 15, false],
      ['oracle/interaction-only', 6, 18, false],
    ]);
  });

  test('weak-matcher and mocks-subject stay warnings', () => {
    expect(meta['oracle/weak-matcher']!.severity).toBe('warn');
    expect(meta['oracle/mocks-subject']!.severity).toBe('warn');
  });

  test('every rule has an id matching its layer, a summary and evidence', () => {
    for (const r of oracleRules) {
      expect(r.id.startsWith('oracle/')).toBe(true);
      expect(r.layer).toBe('oracle');
      expect(r.meta.summary.length).toBeGreaterThan(10);
      expect(['strong', 'moderate', 'weak']).toContain(r.meta.evidence);
    }
  });
});

describe('findings', () => {
  const src = `import { test } from 'vitest';\ntest('x', () => {});`;

  test('carry a one-line message, a hint, evidence, gate and penalty', () => {
    const [f] = run(src).findings;
    expect(f).toMatchObject({
      ruleId: 'oracle/no-assertion',
      layer: 'oracle',
      gate: true,
      evidence: 'strong',
      severity: 'error',
      file: 'a.test.ts',
      penalty: 15,
      loc: { line: 2, col: 1 },
    });
    expect(f!.message).not.toContain('\n');
    expect(f!.hint?.length).toBeGreaterThan(5);
  });

  test('a rule can be turned off', () => {
    expect(run(src, { disabled: ['oracle/no-assertion'] }).findings).toEqual([]);
  });

  test('a file that does not parse has no findings, and says why', () => {
    const r = run('test(');
    expect(r.findings).toEqual([]);
    expect(r.analysis.errors.length).toBeGreaterThan(0);
  });

  test('findings are ordered by position', () => {
    const r = run(
      `import { test, expect } from 'vitest';\ntest('b', () => { expect(f()).toBe(1); });\ntest('a', () => {});\ntest('c', () => {});`,
    );
    expect(r.findings.map((f) => f.loc?.line)).toEqual([3, 4]);
  });
});

describe('assertFunctionNames', () => {
  const src = `import { test } from 'vitest';\nimport { expectOk } from './h.js';\ntest('x', () => { expectOk(f()); });`;
  test('a custom assertion counts only when configured', () => {
    expect(run(src).findings.map((f) => f.ruleId)).toEqual(['oracle/no-assertion']);
    expect(run(src, { assertFunctionNames: ['expectOk'] }).findings).toEqual([]);
  });
});

describe('disabled tests are not judged', () => {
  test('skipped, todo and fixme tests are left to the integrity layer', () => {
    const r = run(
      `import { test } from 'vitest';\ntest.skip('a', () => {});\ntest.todo('b');\ntest.fixme('c', () => {});`,
    );
    expect(r.findings).toEqual([]);
  });
});

describe('partial mocks', () => {
  test('only warn: severity warn and no penalty; a full mock keeps its penalty', () => {
    const partial = run(
      `import { vi, test, expect } from 'vitest';\nimport { f } from './cart.js';\nvi.mock('./cart.js', async (importOriginal) => ({ ...(await importOriginal()), g: vi.fn() }));\ntest('x', () => { expect(f()).toBe(1); });`,
      {},
      'cart.test.ts',
    ).findings;
    expect(partial.map((f) => [f.ruleId, f.severity, f.penalty, f.gate])).toEqual([
      ['oracle/mocks-subject', 'warn', 0, false],
    ]);
    const full = run(
      `import { vi, test, expect } from 'vitest';\nimport { f } from './cart.js';\nvi.mock('./cart.js', () => ({ f: vi.fn() }));\ntest('x', () => { expect(f()).toBe(1); });`,
      {},
      'cart.test.ts',
    ).findings;
    expect(full.map((f) => [f.ruleId, f.severity, f.penalty])).toEqual([
      ['oracle/mocks-subject', 'warn', 15],
    ]);
  });

  test('a mock inside doMock in a function that never runs is not counted', () => {
    const r = run(
      `import { vi, test, expect } from 'vitest';\nimport { f } from './cart.js';\nfunction later() { vi.doMock('./cart.js', () => ({})); }\ntest('x', () => { expect(f()).toBe(1); });`,
      {},
      'cart.test.ts',
    );
    expect(r.findings).toEqual([]);
  });
});

describe('the summary is unchanged by the rules', () => {
  test('same summary as an analysis with no rules', () => {
    const src = `import { test, expect } from 'vitest';\nimport { f } from './f.js';\ntest('x', () => { expect(f()).toBe(1); });\ntest('y', () => {});`;
    const plain = analyzeTestFile('a.test.ts', src, { resolve: false }).summary;
    expect(run(src).analysis.summary).toEqual(plain);
    expect(JSON.stringify(plain)).not.toContain('subjectText');
  });
});

describe('review round 1', () => {
  const ids = (src: string, options = {}, file = 'a.test.ts') =>
    run(src, options, file).findings.map((f) => f.ruleId);
  const V = `import { test, expect, describe, vi } from 'vitest';\nimport { f, load, getStatus } from './x.js';\n`;

  test('a test under a skipped suite is not judged, whatever its own modifier is', () => {
    expect(ids(`${V}describe.skip('s', () => { test.fails('c', () => {}); });`)).toEqual([]);
  });

  test('a named test callback is analysed like an inline one', () => {
    const src = `${V}function body() { const r = f(); const send = vi.fn(); expect(send).toHaveBeenCalled(); }\ntest('x', body);`;
    expect(ids(src)).toEqual(['oracle/interaction-only']);
  });

  test('done is a completion callback only in Jest', () => {
    const body = `async (done) => { expect(await load()).toBe(1); }`;
    expect(
      ids(
        `import { test } from 'node:test';\nimport { load } from './x.js';\nimport assert from 'node:assert';\ntest('x', async (done) => { assert.equal(await load(), 1); });`,
      ),
    ).toEqual([]);
    expect(
      ids(
        `import { test, expect } from '@jest/globals';\nimport { load } from './x.js';\ntest('x', ${body});`,
      ),
    ).toEqual(['oracle/swallowed-async']);
    expect(ids(`${V}test('x', ${body});`)).toEqual([]);
  });

  test('a test that finishes through done is left alone', () => {
    const src = `import { test, expect } from '@jest/globals';\nimport { load } from './x.js';\ntest('x', (done) => { load().then((v) => { expect(v).toBe(1); done(); }).catch(done); });`;
    expect(ids(src)).toEqual([]);
  });

  const taut = (src: string) => ids(src).filter((r) => r === 'oracle/tautological-assertion');
  test('a literal checked against something from the code is not constant', () => {
    expect(taut(`${V}test('x', () => { expect(200).toBe(getStatus()); });`)).toEqual([]);
    expect(taut(`${V}test('x', () => { expect(getStatus()).toBe(200); });`)).toEqual([]);
    expect(taut(`${V}test('x', () => { expect(200).toBe(200); });`)).toEqual([
      'oracle/tautological-assertion',
    ]);
    expect(taut(`${V}test('x', () => { expect(true).toBeTruthy(); });`)).toEqual([
      'oracle/tautological-assertion',
    ]);
  });

  test('a dotted file name keeps its middle part', () => {
    const src = `${V.replace("'./x.js'", "'./cart.service.js'")}vi.mock('./cart.service.js', () => ({ f: vi.fn(), load: vi.fn(), getStatus: vi.fn() }));\ntest('x', () => { expect(f()).toBe(1); });`;
    expect(ids(src, {}, 'src/cart.service.test.ts')).toEqual(['oracle/mocks-subject']);
  });

  test('mock setup is not a captured result, even when chained', () => {
    const src = `${V}test('x', () => { const send = vi.fn().mockResolvedValue(undefined); f(send); expect(send).toHaveBeenCalled(); });`;
    expect(ids(src)).toEqual([]);
  });

  test('a partial mock is one that spreads the real module, not one that takes the parameter', () => {
    const penalty = (factory: string) =>
      run(
        `${V.replace("'./x.js'", "'./cart.js'")}vi.mock('./cart.js', ${factory});\ntest('x', () => { expect(f()).toBe(1); });`,
        {},
        'cart.test.ts',
      ).findings.map((x) => x.penalty);
    expect(penalty(`async (importOriginal) => ({ total: vi.fn() })`)).toEqual([15]);
    expect(penalty(`async (original) => ({ ...(await original()), tax: vi.fn() })`)).toEqual([0]);
    expect(
      penalty(
        `async (importOriginal) => { const actual = await importOriginal(); return { ...actual, tax: vi.fn() }; }`,
      ),
    ).toEqual([0]);
    expect(penalty(`() => ({ ...jest.requireActual('./cart.js'), tax: vi.fn() })`)).toEqual([0]);
  });

  test('Promise.allSettled hides a failure unless its results are read', () => {
    const t = (body: string) => ids(`${V}test('x', async () => { ${body} });`);
    expect(t(`await Promise.allSettled([expect(load()).resolves.toBe(1)]);`)).toEqual([
      'oracle/swallowed-async',
    ]);
    expect(t(`const r = await Promise.allSettled([expect(load()).resolves.toBe(1)]);`)).toEqual([]);
    expect(t(`await Promise.all([expect(load()).resolves.toBe(1)]);`)).toEqual([]);
  });

  test('a mock name reused in another test does not mix them up', () => {
    const src = `${V}test('a', () => {\n  const m = vi.fn().mockReturnValue(42);\n  const result = m();\n  expect(result).toBe(42);\n});\ntest('b', () => {\n  const result = f();\n  expect(result).toBe(42);\n});`;
    const found = run(src).findings.filter((x) => x.ruleId === 'oracle/tautological-mock');
    expect(found.map((x) => x.loc?.line)).toEqual([6]);
  });

  test('values that differ only inside a string are different', () => {
    const t = (expected: string) =>
      ids(
        `${V}test('x', () => { const m = vi.fn().mockReturnValue('a b'); expect(m()).toBe(${expected}); });`,
      );
    expect(t(`'ab'`)).toEqual([]);
    expect(t(`'a b'`)).toEqual(['oracle/tautological-mock']);
  });
});
