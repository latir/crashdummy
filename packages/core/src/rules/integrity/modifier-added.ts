import type { TestCase } from '../../types.js';
import type { IntegrityRule } from './types.js';
import { gateFinding, listIds } from './finding.js';

/** Modifiers that switch a test off. `fails` and `only` are handled separately. */
const DISABLING = new Set<NonNullable<TestCase['modifier']>>(['skip', 'fixme', 'todo']);

const isDisabling = (t: TestCase): boolean => t.modifier !== undefined && DISABLING.has(t.modifier);

/**
 * A test that used to run is now skipped, marked fixme or turned into a todo, or a `.only`
 * appeared (which silently turns off every other test).
 *
 * A `.skip` on a `describe` is reported once, where it is written, not once per test.
 */
export const modifierAdded: IntegrityRule = {
  id: 'integrity/modifier-added',
  layer: 'integrity',
  side: 'after',
  meta: {
    evidence: 'strong',
    summary: 'A test was skipped, marked fixme or todo, or a .only was added.',
  },
  check(ctx) {
    const groups = new Map<string, { modifier: string; loc: TestCase['loc']; ids: string[] }>();
    const add = (t: TestCase): void => {
      const modifier = t.modifier!;
      const loc = t.modifierLoc ?? t.loc;
      const key = `${modifier}@${loc.line}:${loc.col}`;
      const group = groups.get(key) ?? { modifier, loc, ids: [] };
      group.ids.push(t.id);
      groups.set(key, group);
    };

    for (const { before, after } of ctx.pairs) {
      if (isDisabling(after) && !isDisabling(before)) add(after);
      else if (after.modifier === 'only' && before.modifier !== 'only') add(after);
    }
    // a new test does not weaken anything unless it is a .only that disables all the others
    for (const t of ctx.added) if (t.modifier === 'only') add(t);

    return [...groups.values()].map((g) => {
      const many = g.ids.length > 1;
      const subject = many ? `${g.ids.length} tests are` : `test ${listIds(g.ids)} is`;
      return gateFinding(this.id, ctx.file, {
        loc: g.loc,
        message: `${subject} now ${g.modifier}${many ? `: ${listIds(g.ids)}` : ''}`,
        hint:
          g.modifier === 'only'
            ? 'Remove `.only`: it silently skips every other test.'
            : 'Fix the test instead of disabling it. If disabling it is intended, add `// crashdummy-allow integrity/modifier-added: <reason>` above it.',
      });
    });
  },
};

export { isDisabling };
