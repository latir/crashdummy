import type { TestCase } from '../../types.js';
import type { IntegrityRule } from './types.js';
import { gateFinding, listIds } from './finding.js';

type Modifier = NonNullable<TestCase['modifier']>;
type Use = NonNullable<TestCase['modifiers']>[number];

/** Modifiers that switch a test off. `fails` and `only` are handled separately. */
const DISABLING = new Set<Modifier>(['skip', 'fixme', 'todo']);

const isDisablingModifier = (m: Modifier): boolean => DISABLING.has(m);

/** Whether the modifier that wins for this test switches it off. */
export const isDisabling = (t: TestCase): boolean =>
  t.modifier !== undefined && isDisablingModifier(t.modifier);

/** Every modifier that applies to a test, from its `describe`s and from itself. */
const modifiersOf = (t: TestCase): readonly Use[] =>
  t.modifiers ?? (t.modifier ? [{ modifier: t.modifier, loc: t.loc }] : []);

/**
 * A test that used to run is now skipped, marked fixme or turned into a todo, or a `.only`
 * appeared (which silently turns off every other test).
 *
 * All the modifiers on a test's path are compared, not just the one that wins. Otherwise a
 * `describe.only` added over tests that are already skipped, or a `describe.skip` over tests
 * that carry their own `fails`, would leave no trace. A modifier written once on a `describe` is
 * reported once, where it is written, however many tests it reaches.
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
    const add = (test: TestCase, use: Use): void => {
      const key = `${use.modifier}@${use.loc.line}:${use.loc.col}`;
      const group = groups.get(key) ?? { modifier: use.modifier, loc: use.loc, ids: [] };
      group.ids.push(test.id);
      groups.set(key, group);
    };

    for (const { before, after } of ctx.pairs) {
      const was = modifiersOf(before);
      const now = modifiersOf(after);
      // a test that was already switched off does not lose anything to one more reason
      if (!was.some((m) => isDisablingModifier(m.modifier))) {
        const disabled = now.find((m) => isDisablingModifier(m.modifier));
        if (disabled) add(after, disabled);
      }
      if (!was.some((m) => m.modifier === 'only')) {
        const focused = now.find((m) => m.modifier === 'only');
        if (focused) add(after, focused);
      }
    }
    // a new test does not weaken anything unless it is a .only that disables all the others
    for (const t of ctx.added) {
      const focused = modifiersOf(t).find((m) => m.modifier === 'only');
      if (focused) add(t, focused);
    }

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
