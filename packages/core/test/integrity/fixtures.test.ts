import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkIntegrity, integrityRules } from '../../src/rules/integrity/index.js';

/**
 * Before/after fixture pairs: fixtures/integrity/<rule>/{valid,invalid}/<case>.{before,after}.test.ts
 *
 * An `// expect: <ruleId>` comment marks a finding on the line after it (or on its own line when
 * it trails code). Markers in the `before` file are for findings located in the old file
 * (`integrity/test-removed`). A `valid` pair must produce no findings at all.
 */
const ROOT = fileURLToPath(new URL('../../../../fixtures/integrity', import.meta.url));

const sideOf = (ruleId: string): 'before' | 'after' =>
  integrityRules.find((r) => r.id === ruleId)?.side ?? 'after';

function markers(source: string, side: 'before' | 'after'): string[] {
  const out: string[] = [];
  source.split('\n').forEach((text, i) => {
    const m = /^(.*?)\/\/\s*expect:\s*(.+?)\s*$/.exec(text);
    if (!m) return;
    const line = m[1]!.trim() === '' ? i + 2 : i + 1;
    for (const rule of m[2]!.split(',')) out.push(`${rule.trim()} ${side}:${line}`);
  });
  return out;
}

interface Case {
  rule: string;
  kind: 'valid' | 'invalid';
  name: string;
  before: string;
  after: string;
}

const cases: Case[] = [];
for (const rule of readdirSync(ROOT)) {
  for (const kind of ['valid', 'invalid'] as const) {
    const dir = join(ROOT, rule, kind);
    const files = readdirSync(dir).filter((f) => f.endsWith('.before.test.ts'));
    for (const f of files) {
      const name = f.replace('.before.test.ts', '');
      cases.push({
        rule,
        kind,
        name,
        before: readFileSync(join(dir, f), 'utf8'),
        after: readFileSync(join(dir, `${name}.after.test.ts`), 'utf8'),
      });
    }
  }
}

describe('integrity fixtures', () => {
  test('there are fixtures for every gate', () => {
    for (const rule of [
      'test-removed',
      'modifier-added',
      'matcher-weakened',
      'assertions-dropped',
    ]) {
      expect(
        cases.filter((c) => c.rule === rule && c.kind === 'invalid').length,
        rule,
      ).toBeGreaterThan(0);
      expect(
        cases.filter((c) => c.rule === rule && c.kind === 'valid').length,
        rule,
      ).toBeGreaterThan(0);
    }
  });

  describe.each(cases)('$rule/$kind', (c) => {
    test(c.name, () => {
      const { findings, allowed } = checkIntegrity(
        [{ path: 'cart.test.ts', kind: 'modified', before: c.before, after: c.after }],
        { cwd: '/virtual', exists: () => true },
      );
      const actual = findings
        .filter((f) => f.loc)
        .map((f) => `${f.ruleId} ${sideOf(f.ruleId)}:${f.loc!.line}`)
        .sort();
      const expected = [...markers(c.before, 'before'), ...markers(c.after, 'after')].sort();

      expect(actual).toEqual(expected);
      // every finding here is anchored; none may be missing a location
      expect(findings.filter((f) => !f.loc)).toEqual([]);
      if (c.kind === 'valid') expect(expected).toEqual([]);
      if (c.kind === 'invalid') expect(expected.length).toBeGreaterThan(0);
      if (c.rule === 'overrides' && c.kind === 'valid') expect(allowed.length).toBeGreaterThan(0);
    });
  });
});
