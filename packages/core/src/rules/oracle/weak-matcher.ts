import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

/**
 * A value is only checked for existing (`toBeTruthy`, `toBeDefined`, `not.toBeNull`,
 * `expect.anything()`), and nothing in the test checks what it actually is. A stronger assertion on
 * the same subject excuses it. One finding per test.
 *
 * Warning severity until precision is measured on the corpus.
 */
export const weakMatcher: OracleRule = {
  id: 'oracle/weak-matcher',
  layer: 'oracle',
  meta: {
    evidence: 'moderate',
    summary: 'A value is only checked for existing, not for what it is.',
    penalty: 5,
    cap: 15,
    gate: false,
    severity: 'warn',
  },
  create(ctx) {
    return {
      finish() {
        const findings = [];
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier)) continue;
          const strong = new Set<string | undefined>();
          for (const a of test.assertions) if (a.strength > 1) strong.add(a.subjectText);
          const weak = test.assertions.find(
            (a) => a.strength === 1 && !(a.subjectText !== undefined && strong.has(a.subjectText)),
          );
          if (!weak) continue;
          findings.push(
            oracleFinding(weakMatcher, ctx.file, {
              loc: weak.loc,
              message: `test '${test.id}' only checks that ${weak.subjectText ?? 'a value'} exists (${weak.negated ? 'not.' : ''}${weak.matcher})`,
              hint: 'Assert the expected value, for example `toEqual(...)` or `toBe(...)`.',
            }),
          );
        }
        return findings;
      },
    };
  },
};
