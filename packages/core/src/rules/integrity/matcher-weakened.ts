import type { MatcherUse } from '../../types.js';
import type { IntegrityRule } from './types.js';
import { gateFinding } from './finding.js';

const same = (a: MatcherUse, b: MatcherUse): boolean =>
  a.name === b.name &&
  a.negated === b.negated &&
  a.strength === b.strength &&
  a.chain === b.chain &&
  a.rank === b.rank;

/**
 * Is `after` a weaker assertion than `before`?
 *
 * This uses what the summary recorded for each assertion: its polarity, its strength, and where
 * it sits in the lattice once its argument is known. Nothing is looked up again by name, which
 * would lose the argument (`toHaveText('x')` is not `toHaveText(/x/)`) and would apply an alias's
 * negation a second time (`assert.notStrictEqual` is stored as already negated).
 *
 * - Positive to negated (`toEqual` to `not.toEqual`) is weaker. Two negated assertions are not
 *   compared.
 * - A different matcher in the same lattice chain: weaker if it sits lower (`toStrictEqual` to
 *   `toEqual`, `toHaveText('x')` to `toContainText('x')`).
 * - Anything else, including the same matcher with a different argument, is judged on strength.
 *   Only a real drop counts: to existence-only, or by two levels. Moving from a literal to a
 *   variable (`toBe(5)` to `toBe(expected)`) is usually a refactor, while `toThrow('msg')` to
 *   `toThrow()` or `toEqual({..})` to `toEqual(expect.anything())` is not.
 * - A matcher the lattice does not know is never reported.
 */
function weaker(before: MatcherUse, after: MatcherUse): boolean {
  if (before.chain === undefined || after.chain === undefined) return false;
  // `not.toEqual(x)` and `not.toMatchObject(y)`: the chain orders positive assertions, and negation
  // turns that order around, so two negated assertions cannot be ranked
  if (before.negated && after.negated) return false;
  if (before.negated !== after.negated) return !before.negated && after.negated;
  if (
    before.name !== after.name &&
    before.chain === after.chain &&
    before.rank !== undefined &&
    after.rank !== undefined &&
    before.rank !== after.rank
  ) {
    return after.rank > before.rank;
  }
  const drop = before.strength - after.strength;
  return drop > 0 && (after.strength <= 2 || drop >= 2);
}

/**
 * Pair up the assertions of a test before and after, in two steps, so reordering is not a change:
 * identical assertions cancel out first, and the leftovers are compared in order.
 */
export function weakenedAssertions(
  before: readonly MatcherUse[],
  after: readonly MatcherUse[],
): { from: MatcherUse; to: MatcherUse }[] {
  const rest = [...after];
  const leftover: MatcherUse[] = [];
  for (const b of before) {
    const i = rest.findIndex((a) => same(a, b));
    if (i >= 0) rest.splice(i, 1);
    else leftover.push(b);
  }
  const out: { from: MatcherUse; to: MatcherUse }[] = [];
  for (let i = 0; i < Math.min(leftover.length, rest.length); i++) {
    if (weaker(leftover[i]!, rest[i]!)) out.push({ from: leftover[i]!, to: rest[i]! });
  }
  return out;
}

const label = (m: MatcherUse): string => `${m.negated ? 'not.' : ''}${m.name}`;

/** An assertion moved down the matcher strength lattice, for example `toEqual` to `toBeTruthy`. */
export const matcherWeakened: IntegrityRule = {
  id: 'integrity/matcher-weakened',
  layer: 'integrity',
  side: 'after',
  meta: {
    evidence: 'strong',
    summary: 'An assertion was loosened to a weaker matcher.',
  },
  check(ctx) {
    const findings = [];
    for (const { before, after } of ctx.pairs) {
      const changes = weakenedAssertions(before.matchers, after.matchers);
      if (changes.length === 0) continue;
      const shown = changes
        .slice(0, 3)
        .map((c) => `${label(c.from)} became ${label(c.to)}`)
        .join('; ');
      const more = changes.length > 3 ? ` (+${changes.length - 3} more)` : '';
      findings.push(
        gateFinding(this.id, ctx.file, {
          loc: after.loc,
          message: `test '${after.id}' got weaker assertions: ${shown}${more}`,
          hint: 'Assert the exact value again. If loosening it is intended, add `// crashdummy-allow integrity/matcher-weakened: <reason>` above the test.',
        }),
      );
    }
    return findings;
  },
};
