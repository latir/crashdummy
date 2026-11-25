import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkOracle, oracleRules } from '../src/rules/oracle/index.js';

/**
 * Fixtures: fixtures/oracle/<rule>/{valid,invalid}/<case>.test.ts
 *
 * An `// expect: <ruleId>` comment marks a finding on the line after it (or on its own line when
 * it trails code). A `valid` file must produce no findings from that rule. A first line
 * `// options: {...}` passes analysis options, such as `assertFunctionNames`, and `path` to name the file.
 */
const ROOT = fileURLToPath(new URL('../../../fixtures/oracle', import.meta.url));

function markers(source: string): string[] {
  const out: string[] = [];
  source.split('\n').forEach((text, i) => {
    const m = /^(.*?)\/\/\s*expect:\s*(.+?)\s*$/.exec(text);
    if (!m) return;
    const line = m[1]!.trim() === '' ? i + 2 : i + 1;
    for (const rule of m[2]!.split(',')) out.push(`${rule.trim()}:${line}`);
  });
  return out.sort();
}

const optionsOf = (source: string): Record<string, unknown> => {
  const m = /^\/\/\s*options:\s*(.+)$/m.exec(source);
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {};
};

describe('oracle rule fixtures', () => {
  test('there is a fixture folder for every rule', () => {
    const folders = readdirSync(ROOT).sort();
    expect(folders).toEqual(oracleRules.map((r) => r.id.replace('oracle/', '')).sort());
  });

  for (const rule of readdirSync(ROOT)) {
    for (const kind of ['valid', 'invalid'] as const) {
      const dir = join(ROOT, rule, kind);
      const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
      test(`${rule}/${kind} has fixtures`, () => {
        expect(files.length).toBeGreaterThan(0);
      });
      for (const f of files) {
        test(`${rule}/${kind}/${f}`, () => {
          const source = readFileSync(join(dir, f), 'utf8');
          const id = `oracle/${rule}`;
          const rules = oracleRules.filter((r) => r.id === id);
          // `path` names the file the rule sees: some rules look at the test file's own name
          const { path, ...options } = optionsOf(source);
          const { findings, analysis } = checkOracle(
            typeof path === 'string' ? path : `fixtures/${rule}/${kind}/${f}`,
            source,
            { resolve: false, ...options },
            rules,
          );
          expect(analysis.errors).toEqual([]);
          const got = findings.map((x) => `${x.ruleId}:${x.loc?.line}`).sort();
          if (kind === 'invalid') expect(markers(source).length).toBeGreaterThan(0);
          expect(got).toEqual(kind === 'valid' ? [] : markers(source));
        });
      }
    }
  }
});
