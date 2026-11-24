import type { MatcherUse } from '../../types.js';
import type { Lattice } from '../lattice.js';
import type { IntegrityRule } from './types.js';
import { gateFinding } from './finding.js';

const same = (a: MatcherUse, b: MatcherUse): boolean =>
  a.name === b.name && a.negated === b.negated && a.strength === b.strength;

/**
 * Is `after` a weaker assertion than `before`?
 *
 * - Both in the same lattice chain: it is weaker if it sits lower in the chain
 *   (`toStrictEqual` to `toEqual`, `toEqual` to `toMatchObject`).
 * - Positive to negated (`toEqual` to `not.toEqual`) is weaker.
 * - Anything else is judged on the strengths recorded for the two assertions themselves, which
 *   include the argument (`toThrow('msg')` is stronger than `toThrow()`; `toEqual(5)` and
 *   `toBe(5)` are equal). Only a real drop counts: to existence-only, or by two levels. Moving
 *   from a literal to a variable (`toBe(5)` to `toBe(expected)`) is usually a refactor.
 * - A matcher the lattice does not know is never reported.
 */
function weaker(before: MatcherUse, after: MatcherUse, lattice: Lattice): boolean {
  const b = lattice.resolveMatcher({ name: before.name, negated: before.negated });
  const a = lattice.resolveMatcher({ name: after.name, negated: after.negated });
  if (!b.known || !a.known) return false;

  if (b.negated !== a.negated) return !b.negated && a.negated;
  if (b.chain === a.chain && b.rank !== undefined && a.rank !== undefined && b.rank !== a.rank) {
    return a.rank > b.rank;
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
  lattice: Lattice,
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
    if (weaker(leftover[i]!, rest[i]!, lattice)) out.push({ from: leftover[i]!, to: rest[i]! });
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
      const changes = weakenedAssertions(before.matchers, after.matchers, ctx.lattice);
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
