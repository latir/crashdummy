import { describe, expect, it } from 'vitest';
import * as core from '../../packages/core/src/index.js';
import { candidates, failing, judge, sample, summarize } from './mutants.mjs';

const SOURCE = `import { expect, test } from 'vitest';
import { add, load, render } from './x.js';

test('adds two small numbers together', () => {
  expect(add(1, 2)).toBe(3);
  expect(add(2, 2)).toEqual(4);
});

test('renders the page heading and loads data', async () => {
  const html = render();
  expect(html).toContain('<h1>');
  await expect(load()).resolves.toBe(1);
});

test('adds a few more small numbers', () => {
  expect(add(2, 3)).toBe(5);
  expect(add(3, 3)).toBe(6);
});
`;
const PATH = 'x.test.ts';
const analysis = () => core.analyzeTestFile(PATH, SOURCE, { resolve: false });

describe('candidates', () => {
  const all = candidates(analysis(), SOURCE);
  const ops = new Set(all.map((m) => m.op));

  it('offers every operator on a file that has what it needs', () => {
    for (const op of [
      'drop-assertion',
      'weaken-matcher',
      'add-skip',
      'add-only',
      'remove-test',
      'strip-assertions',
      'weaken-all',
      'tautology',
      'swallow-async',
      'rename-test',
      'strengthen-matcher',
      'rename-and-retune',
      'swap-sibling-matcher',
      'add-test',
    ]) {
      expect(ops.has(op), op).toBe(true);
    }
  });

  it('every mutant still parses and differs from the original', () => {
    for (const m of all) {
      expect(m.after, m.op).not.toBe(SOURCE);
      expect(core.analyzeTestFile(PATH, m.after, { resolve: false }).errors, m.op).toEqual([]);
    }
  });

  it('does not offer to drop an assertion from a test that has only one', () => {
    const one = `import { expect, test } from 'vitest';\ntest('a', () => {\n  expect(1).toBe(1);\n});\ntest('b', () => {\n  expect(2).toBe(2);\n});\n`;
    const a = core.analyzeTestFile(PATH, one, { resolve: false });
    expect(candidates(a, one).some((m) => m.op === 'drop-assertion')).toBe(false);
  });
});

describe('judge', () => {
  it('catches every breaking mutant and stays quiet on every harmless one', () => {
    const all = candidates(analysis(), SOURCE);
    const bad = all
      .map((m) => ({ m, r: judge(core, PATH, SOURCE, m) }))
      .filter(({ r }) => !r.ok)
      .map(
        ({ m, r }) =>
          `${m.op} on '${m.testId}': ${r.got.map((f) => f.ruleId).join(',') || 'nothing'}`,
      );
    expect(bad).toEqual([]);
  });

  it('says a breaking mutant was missed when the engine reports something else', () => {
    const m = {
      op: 'x',
      kind: 'breaking',
      layer: 'oracle',
      testId: 'adds two small numbers together',
      expected: 'oracle/swallowed-async',
      after: SOURCE.replace('expect(add(1, 2)).toBe(3);', 'void 0;'),
    };
    expect(judge(core, PATH, SOURCE, m).ok).toBe(false);
  });

  it('says a harmless mutant was noisy when it produces a finding', () => {
    const m = {
      op: 'x',
      kind: 'harmless',
      layer: 'integrity',
      testId: 'adds two small numbers together',
      after: SOURCE.replace(/test\('adds a few more[\s\S]*$/, ''),
    };
    expect(judge(core, PATH, SOURCE, m).ok).toBe(false);
  });
});

describe('sampling and summaries', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    op: i % 2 ? 'a' : 'b',
    kind: 'breaking',
    i,
  }));
  it('takes a fixed number per operator, the same each time', () => {
    const a = sample(many, 5, 's');
    expect(a.filter((m) => m.op === 'a')).toHaveLength(5);
    expect(a.filter((m) => m.op === 'b')).toHaveLength(5);
    expect(sample(many, 5, 's')).toEqual(a);
    expect(sample(many, 5, 'other')).not.toEqual(a);
  });

  it('flags operators below the bar, in each direction', () => {
    const results = [
      ...Array.from({ length: 10 }, (_, i) => ({ op: 'brk', kind: 'breaking', ok: i < 8 })),
      ...Array.from({ length: 10 }, (_, i) => ({ op: 'quiet', kind: 'harmless', ok: i < 9 })),
      ...Array.from({ length: 10 }, () => ({ op: 'fine', kind: 'breaking', ok: true })),
    ];
    expect(failing(summarize(results)).sort()).toEqual(['brk', 'quiet']);
  });
});

describe('looksBoolean', () => {
  it('knows a yes/no subject from a value', async () => {
    const { looksBoolean } = await import('./mutants.mjs');
    for (const t of ['!x', 'a === b', 'list.includes(x)', 'result.success', 'user.isAdmin()'])
      expect(looksBoolean(t), t).toBe(true);
    for (const t of ['add(1, 2)', 'user.name', 'render()']) expect(looksBoolean(t), t).toBe(false);
  });
});
