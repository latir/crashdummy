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
  const imported = (name: string): string =>
    `import { test } from 'vitest';\nimport { ${name} } from './h.js';\ntest('x', () => { ${name}(f()); });`;
  test('an imported helper named expectX or assertX counts without configuration', () => {
    expect(run(imported('expectOk')).findings).toEqual([]);
    expect(run(imported('assertNoViolations')).findings).toEqual([]);
  });
  test('any other helper name counts only when configured', () => {
    expect(run(imported('verifyOk')).findings.map((f) => f.ruleId)).toEqual([
      'oracle/no-assertion',
    ]);
    expect(run(imported('verifyOk'), { assertFunctionNames: ['verifyOk'] }).findings).toEqual([]);
  });
  test('names that only start like a check do not count', () => {
    expect(run(imported('expected')).findings.map((f) => f.ruleId)).toEqual([
      'oracle/no-assertion',
    ]);
    expect(run(imported('assertion')).findings.map((f) => f.ruleId)).toEqual([
      'oracle/no-assertion',
    ]);
  });
  test('a helper in the same file is followed, whatever it is called', () => {
    const local = `import { test } from 'vitest';\nfunction expectOk(v: unknown) { return v; }\ntest('x', () => { expectOk(f()); });`;
    expect(run(local).findings.map((f) => f.ruleId)).toEqual(['oracle/no-assertion']);
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

describe('review round 2', () => {
  const ids = (src: string, options = {}, file = 'a.test.ts') =>
    run(src, options, file).findings.map((f) => f.ruleId);
  const V = `import { test, expect, vi } from 'vitest';\nimport { f, load, getStatus } from './x.js';\n`;
  const asyncTest = (body: string) => ids(`${V}test('x', async () => { ${body} });`);

  test('a spread into an object that is never returned is not a partial mock', () => {
    const penalty = (factory: string) =>
      run(
        `${V.replace("'./x.js'", "'./cart.js'")}vi.mock('./cart.js', ${factory});\ntest('x', () => { expect(f()).toBe(1); });`,
        {},
        'cart.test.ts',
      ).findings.map((x) => x.penalty);
    expect(
      penalty(
        `async (original) => { const copy = { ...(await original()) }; return { total: vi.fn() }; }`,
      ),
    ).toEqual([15]);
    expect(
      penalty(
        `async (original) => { const copy = { ...(await original()), tax: vi.fn() }; return copy; }`,
      ),
    ).toEqual([0]);
    expect(penalty(`(importOriginal) => importOriginal()`)).toEqual([0]);
  });

  test('messages stay on one line even when they quote a multiline call', () => {
    const r = run(
      `${V}test('x', () => {\n  expect(f(\n    1,\n    2,\n  )).toBeTruthy();\n});`,
    ).findings;
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) expect(`${x.message}${x.hint ?? ''}`).not.toMatch(/[\r\n]/);
  });

  test('toHaveReturnedWith checks the value that came back', () => {
    const src = `${V}test('x', () => { const spy = vi.spyOn(Math, 'max'); const r = f(spy); expect(spy).toHaveReturnedWith(42); });`;
    expect(ids(src)).toEqual([]);
    const only = `${V}test('x', () => { const spy = vi.spyOn(Math, 'max'); const r = f(spy); expect(spy).toHaveReturned(); });`;
    expect(ids(only)).toEqual(['oracle/interaction-only']);
  });

  test('Promise.any and Promise.race can hide a failing assertion', () => {
    const t = (c: string) =>
      asyncTest(`await Promise.${c}([Promise.resolve(), expect(load()).resolves.toBe(1)]);`);
    expect(t('any')).toEqual(['oracle/swallowed-async']);
    expect(t('race')).toEqual(['oracle/swallowed-async']);
    expect(t('all')).toEqual([]);
    expect(asyncTest(`await Promise.race([expect(load()).resolves.toBe(1)]);`)).toEqual([]);
  });

  test('awaiting an array does not wait for its elements', () => {
    expect(asyncTest(`await [expect(load()).resolves.toBe(1)];`)).toEqual([
      'oracle/swallowed-async',
    ]);
    expect(
      asyncTest(`const all = [expect(load()).resolves.toBe(1)]; await Promise.all(all);`),
    ).toEqual([]);
  });

  test('only the last operand of a sequence comes out of it', () => {
    expect(asyncTest(`return (expect(load()).resolves.toBe(1), Promise.resolve());`)).toEqual([
      'oracle/swallowed-async',
    ]);
    expect(asyncTest(`return (Promise.resolve(), expect(load()).resolves.toBe(1));`)).toEqual([]);
  });

  test('void discards the promise', () => {
    expect(asyncTest(`void expect(load()).resolves.toBe(1);`)).toEqual(['oracle/swallowed-async']);
  });

  test('an opaque assertion helper with literal arguments is not constant', () => {
    const src = `${V}import * as helpers from './h.js';\ntest('x', () => { helpers.expectTotal(3); });`;
    expect(ids(src, { assertFunctionNames: ['helpers.expectTotal'] })).toEqual([]);
  });

  test('reassigning a variable replaces what it held', () => {
    const src = `${V}test('x', () => {\n  const m = vi.fn().mockReturnValue(42);\n  let result = m();\n  result = f();\n  expect(result).toBe(42);\n});`;
    expect(ids(src)).toEqual([]);
    const plain = `${V}test('x', () => {\n  const m = vi.fn().mockReturnValue(42);\n  let result = f();\n  result = m();\n  expect(result).toBe(42);\n});`;
    expect(ids(plain)).toEqual(['oracle/tautological-mock']);
  });

  test('mock setup in a function nobody calls does not apply', () => {
    const src = `${V}function unused() { vi.mocked(f).mockReturnValue(42); }\ntest('x', () => { expect(f()).toBe(42); });`;
    expect(ids(src)).toEqual([]);
    const hook = `${V}beforeEach(() => { vi.mocked(f).mockReturnValue(42); });\ntest('x', () => { expect(f()).toBe(42); });`;
    expect(ids(hook.replace('{ test,', '{ beforeEach, test,'))).toEqual([
      'oracle/tautological-mock',
    ]);
  });

  test('a result is judged against the mock as it was when the value was produced', () => {
    const t = (expected: number) =>
      ids(
        `${V}test('x', () => { const m = vi.fn().mockReturnValue(1); const result = m(); m.mockReturnValue(2); expect(result).toBe(${expected}); });`,
      );
    expect(t(2)).toEqual([]);
    expect(t(1)).toEqual(['oracle/tautological-mock']);
  });
});

describe('review round 3', () => {
  const ids = (src: string, options = {}, file = 'a.test.ts') =>
    run(src, options, file).findings.map((f) => f.ruleId);
  const V = `import { test, expect, vi } from 'vitest';\nimport { f, load, calculate, notify } from './x.js';\n`;
  const asyncTest = (body: string) => ids(`${V}test('x', async () => { ${body} });`);

  test('a competitor that may reject cannot hide the assertion, one that fulfils can', () => {
    expect(asyncTest(`await Promise.race([expect(load()).resolves.toBe(1), timeout()]);`)).toEqual(
      [],
    );
    expect(
      asyncTest(`await Promise.race([expect(load()).resolves.toBe(1), Promise.resolve()]);`),
    ).toEqual(['oracle/swallowed-async']);
    expect(
      asyncTest(`await Promise.any([expect(load()).resolves.toBe(1), Promise.resolve(1)]);`),
    ).toEqual(['oracle/swallowed-async']);
  });

  test('a callback on a settled promise may rethrow, so it is left unknown', () => {
    expect(
      asyncTest(
        `await Promise.allSettled([expect(load()).resolves.toBe(1)]).then(([r]) => { if (r.status === 'rejected') throw r.reason; });`,
      ),
    ).toEqual([]);
    expect(asyncTest(`await Promise.allSettled([expect(load()).resolves.toBe(1)]);`)).toEqual([
      'oracle/swallowed-async',
    ]);
  });

  test('a nested call to the original is not the original module', () => {
    const penalty = (factory: string) =>
      run(
        `${V.replace("'./x.js'", "'./cart.js'")}vi.mock('./cart.js', ${factory});\ntest('x', () => { expect(f()).toBe(1); });`,
        {},
        'cart.test.ts',
      ).findings.map((x) => x.penalty);
    expect(
      penalty(
        `async (original) => { const replacement = { total: vi.fn(), original: await original() }; return replacement; }`,
      ),
    ).toEqual([15]);
    expect(penalty(`async (original) => ({ ...(await original()), total: vi.fn() })`)).toEqual([0]);
  });

  test('mock setup counts in aliased and named test callbacks', () => {
    const body = `const m = vi.fn().mockReturnValue(42); expect(m()).toBe(42);`;
    expect(ids(`${V.replace('{ test,', '{ test as spec,')}spec('x', () => { ${body} });`)).toEqual([
      'oracle/tautological-mock',
    ]);
    expect(ids(`${V}function body() { ${body} }\ntest('x', body);`)).toEqual([
      'oracle/tautological-mock',
    ]);
  });

  test('a property read can differ from itself', () => {
    expect(
      ids(`${V}test('x', () => { const s = f(); expect(s.snapshot).toBe(s.snapshot); });`),
    ).toEqual([]);
    expect(ids(`${V}test('x', () => { const s = f(); expect(s).toBe(s); });`)).toEqual([
      'oracle/tautological-assertion',
    ]);
  });

  test('a matcher outside the lattice is not judged by its arguments', () => {
    expect(ids(`${V}test('x', () => { expect('/health').toReturn200(); });`)).toEqual([]);
  });

  test('interaction aliases from the lattice count as interactions', () => {
    const t = (matcher: string) =>
      ids(
        `${V}test('x', () => { const send = vi.fn(); const r = calculate(send); expect(send).${matcher}; });`,
      );
    expect(t('lastCalledWith(1)')).toEqual(['oracle/interaction-only']);
    expect(t('nthCalledWith(1, 2)')).toEqual(['oracle/interaction-only']);
    expect(t('toReturn()')).toEqual(['oracle/interaction-only']);
    expect(t('toReturnWith(1)')).toEqual([]);
  });

  test('functions inside the test that nothing calls are not part of it', () => {
    const src = `${V}test('x', () => { function unused() { const result = calculate(); } const send = vi.fn(); notify(send); expect(send).toHaveBeenCalled(); });`;
    expect(ids(src)).toEqual([]);
  });

  test('the mocking library under another name is still the mocking library', () => {
    const src = `import { test, expect, vi as mocks } from 'vitest';\nimport { notify } from './x.js';\ntest('x', () => { const send = mocks.fn(); notify(send); expect(send).toHaveBeenCalled(); });`;
    expect(ids(src)).toEqual([]);
  });

  test('a one-shot value used up by an earlier call is not what the result got', () => {
    const t = (body: string) =>
      ids(`${V}test('x', () => { const m = vi.fn(f).mockReturnValueOnce(42); ${body} });`);
    expect(t(`m(); expect(m()).toBe(42);`)).toEqual([]);
    expect(t(`expect(m()).toBe(42);`)).toEqual(['oracle/tautological-mock']);
  });

  test('the same call written twice is not the same value', () => {
    const t = (expected: string, mock = 'nextId()') =>
      ids(
        `${V}test('x', () => { const m = vi.fn().mockReturnValue(${mock}); expect(m()).toEqual(${expected}); });`,
      );
    expect(t('nextId()')).toEqual([]);
    expect(t('{ a: 1 }', '{ a: 1 }')).toEqual(['oracle/tautological-mock']);
    expect(
      ids(
        `${V}test('x', () => { const m = vi.fn().mockReturnValue({ a: 1 }); expect(m()).toBe({ a: 1 }); });`,
      ),
    ).toEqual([]);
  });
});
