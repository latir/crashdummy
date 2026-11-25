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
