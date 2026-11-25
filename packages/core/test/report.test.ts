import { describe, expect, test } from 'vitest';
import {
  AGENT_MAX_LINES,
  explainMatchers,
  explainRule,
  explainableRules,
  formatAgent,
  formatJson,
  formatPretty,
  formatReport,
  integrityRules,
  oracleRules,
  score,
} from '../src/index.js';
import type { ChangedFile, FileScore, Finding, Report } from '../src/types.js';

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'oracle/no-assertion',
  layer: 'oracle',
  gate: true,
  evidence: 'strong',
  severity: 'error',
  file: 'a.test.ts',
  loc: { line: 14, col: 1 },
  message: "test 'adds' has no assertion",
  hint: 'Assert on the result',
  penalty: 15,
  ...over,
});

const fileScore = (over: Partial<FileScore> = {}): FileScore => ({
  file: 'src/cart.test.ts',
  status: 'scored',
  score: 58,
  findings: [finding()],
  subscores: { static: 58, coverage: 'unknown', mutation: 'unknown' },
  confidence: 'static-estimate',
  gates: [finding()],
  ...over,
});

const report = (files: FileScore[], over: Partial<Report> = {}): Report => ({
  version: 1,
  tiersRun: [0],
  durationMs: 3,
  files,
  verdict: 'fail',
  ...over,
});

describe('agent format', () => {
  test('is plain text with an imperative fix, and no weights or colours', () => {
    const out = formatAgent(report([fileScore()]));
    expect(out).toBe(
      [
        'crashdummy: FAIL (1 file)',
        'src/cart.test.ts  58/100 · static 58',
        "  - line 14: test 'adds' has no assertion. Assert on the result.",
        'Run `npx crashdummy explain <rule>` for details.',
      ].join('\n'),
    );
    expect(out.includes('\u001b')).toBe(false);
    expect(out).not.toMatch(/penalty|weight|15\b/);
  });

  test('a passing report is one line', () => {
    expect(
      formatAgent(
        report([fileScore({ findings: [], gates: [], score: 100 })], { verdict: 'pass' }),
      ),
    ).toBe('crashdummy: PASS (1 file)');
  });

  test('never more than 25 lines, however many findings', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      fileScore({
        file: `src/f${i}.test.ts`,
        findings: [
          finding(),
          finding({ loc: { line: 2, col: 1 } }),
          finding({ loc: { line: 3, col: 1 } }),
          finding({ loc: { line: 4, col: 1 } }),
        ],
      }),
    );
    const out = formatAgent(report(many));
    expect(out.split('\n').length).toBeLessThanOrEqual(AGENT_MAX_LINES);
    expect(out).toMatch(/more findings? .*not shown/);
    expect(out.split('\n').at(-1)).toMatch(/explain/);
  });

  test('at most three findings per file', () => {
    const out = formatAgent(
      report([
        fileScore({
          findings: Array.from({ length: 6 }, (_, i) => finding({ loc: { line: i + 1, col: 1 } })),
        }),
      ]),
    );
    expect(out.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(3);
    expect(out).toContain('3 more findings');
  });

  test('an unparseable file is one instruction and has no score', () => {
    const bad = fileScore({
      file: 'src/cart/cart.test.ts',
      status: 'unparseable',
      findings: [],
      gates: [],
      error: { line: 12, col: 3, message: 'Unexpected token' },
    });
    delete (bad as { score?: number }).score;
    expect(formatAgent(report([bad]))).toContain(
      'src/cart/cart.test.ts: could not parse (line 12: Unexpected token). Fix the syntax error, then re-run.',
    );
  });

  test('info findings are not shown', () => {
    const info = finding({ severity: 'info', gate: false, penalty: 0, message: 'noted' });
    const out = formatAgent(
      report([fileScore({ findings: [info], gates: [] })], { verdict: 'warn' }),
    );
    expect(out).not.toContain('noted');
  });

  test('unknown matchers are not mentioned', () => {
    const out = formatAgent(
      report([fileScore()], { unknownMatchers: [{ name: 'toX', count: 1, files: ['a'] }] }),
    );
    expect(out).not.toContain('toX');
  });
});

describe('pretty format', () => {
  test('score per file out of 100 and the top 3 findings', () => {
    const out = formatPretty(
      report(
        [
          fileScore({
            findings: Array.from({ length: 5 }, (_, i) =>
              finding({ loc: { line: i + 1, col: 1 } }),
            ),
          }),
        ],
        {
          suite: { score: 58 },
        },
      ),
    );
    expect(out).toContain('crashdummy FAIL · 1 file · suite 58/100 · static estimate');
    expect(out).toContain('src/cart.test.ts  58/100');
    expect(out.split('\n').filter((l) => l.includes('oracle/no-assertion'))).toHaveLength(3);
    expect(out).toContain('… and 2 more');
  });

  test('no escape codes unless colour is on', () => {
    expect(formatPretty(report([fileScore()]))).not.toContain('\u001b');
    expect(formatPretty(report([fileScore()]), { color: true })).toContain('\u001b[');
  });

  test('an unparseable file is "not checked", never shown with a score', () => {
    const bad = fileScore({
      status: 'unparseable',
      findings: [],
      gates: [],
      error: { line: 2, col: 5, message: 'Unexpected token' },
    });
    delete (bad as { score?: number }).score;
    const out = formatPretty(report([bad]));
    expect(out).toContain('not checked');
    expect(out).toContain('line 2, col 5: Unexpected token');
    expect(out).not.toMatch(/\d+\/100 ·/);
  });

  test('one footer line for matchers it does not know', () => {
    const out = formatPretty(
      report([fileScore()], {
        unknownMatchers: [
          { name: 'toA', count: 1, files: ['a'] },
          { name: 'toB', count: 1, files: ['a'] },
        ],
      }),
    );
    expect(out).toContain(
      '2 matchers not recognised (toA, toB). Add them under "matchers" in config.',
    );
  });
});

describe('json format', () => {
  test('is the versioned report', () => {
    const r = report([fileScore()]);
    expect(JSON.parse(formatJson(r))).toEqual(r);
    expect(JSON.parse(formatJson(r)).version).toBe(1);
  });

  test('an unparseable file has its own status and no score', () => {
    const bad = fileScore({
      status: 'unparseable',
      findings: [],
      gates: [],
      error: { line: 1, col: 1, message: 'x' },
    });
    delete (bad as { score?: number }).score;
    const parsed = JSON.parse(formatJson(report([bad])));
    expect(parsed.files[0]).toMatchObject({ status: 'unparseable', error: { line: 1 } });
    expect(parsed.files[0]).not.toHaveProperty('score');
  });

  test('formatReport picks the format', () => {
    const r = report([fileScore()]);
    expect(formatReport(r, 'json')).toBe(formatJson(r));
    expect(formatReport(r, 'agent')).toBe(formatAgent(r));
    expect(formatReport(r, 'pretty')).toBe(formatPretty(r));
  });
});

describe('explain', () => {
  test('every rule has an explanation', () => {
    const ids = [...oracleRules, ...integrityRules].map((r) => r.id);
    const known = new Set(explainableRules());
    expect(ids.filter((id) => !known.has(id))).toEqual([]);
  });

  test('covers the extra ids the engine can emit', () => {
    for (const id of [
      'integrity/unparseable',
      'integrity/allow-without-reason',
      'info/unknown-matcher',
    ]) {
      expect(explainRule(id)).toBeDefined();
    }
  });

  test('prints the principle, the evidence and an example fix', () => {
    const out = explainRule('oracle/swallowed-async')!;
    expect(out).toContain('oracle/swallowed-async');
    expect(out).toContain('Why:');
    expect(out).toContain('Evidence');
    expect(out).toContain('Instead of:');
    expect(out).toContain('await expect(load()).resolves.toBe(1)');
  });

  test('an unknown rule has no explanation', () => {
    expect(explainRule('oracle/nope')).toBeUndefined();
  });

  test('matchers: a list and a snippet to paste', () => {
    const out = explainMatchers([{ name: 'toBeWithinRange', count: 2, files: ['a.test.ts'] }]);
    expect(out).toContain('toBeWithinRange  2 uses in a.test.ts');
    expect(out).toContain('"matchers"');
    expect(JSON.parse(out.slice(out.indexOf('{')))).toEqual({
      matchers: { toBeWithinRange: { strength: 3 } },
    });
    expect(explainMatchers([])).toContain('Every matcher');
  });
});

describe('end to end', () => {
  const changes: ChangedFile[] = [
    {
      path: 'a.test.ts',
      kind: 'added',
      after: `import { test } from 'vitest';\ntest('x', () => {});`,
    },
  ];

  test('agent output from a real run stays short and names the problem', async () => {
    const r = await score(changes, { cwd: '/nonexistent' });
    const out = formatAgent(r);
    expect(out).toContain('crashdummy: FAIL');
    expect(out).toContain("test 'x' has no assertion");
    expect(out.split('\n').length).toBeLessThanOrEqual(AGENT_MAX_LINES);
  });
});
