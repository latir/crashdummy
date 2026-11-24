import type { TestCase } from '../../types.js';
import type { IntegrityRule } from './types.js';
import { gateFinding, listIds } from './finding.js';

type Modifier = NonNullable<TestCase['modifier']>;
type Use = NonNullable<TestCase['modifiers']>[number];

/** Modifiers that switch a test off. `fails` and `only` are handled separately. */
const DISABLING = new Set<Modifier>(['skip', 'fixme', 'todo']);

const isDisablingModifier = (m: Modifier): boolean => DISABLING.has(m);

/** Every modifier that applies to a test, from its `describe`s and from itself. */
const modifiersOf = (t: TestCase): readonly Use[] =>
  t.modifiers ?? (t.modifier ? [{ modifier: t.modifier, loc: t.loc }] : []);

/**
 * Whether any modifier on the test's path switches it off, not just the one that wins: a test
 * with its own `fails` under a `describe.skip` is skipped.
 */
export const isDisabling = (t: TestCase): boolean =>
  modifiersOf(t).some((m) => isDisablingModifier(m.modifier));

/**
 * Where a modifier was written: on the test itself, or on the `describe` at some depth of its
 * path. The depth stands in for the suite's identity, so renaming a `describe.only` is not a new
 * focus, while a `describe.only` added one level further in still is.
 */
const originOf = (m: Use): string =>
  m.suite === undefined ? 'own' : `suite:${m.suite.split(' > ').length}`;

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

    // suites (as named after the change) whose focus was already there before it
    const unchangedSuites = new Set<string>();
    for (const { before, after } of ctx.pairs) {
      const was = modifiersOf(before);
      const now = modifiersOf(after);
      // a test that was already switched off does not lose anything to one more reason. When it
      // was not, every place that now switches it off is new, so each is reported (a suite
      // override must not hide the test's own).
      if (!was.some((m) => isDisablingModifier(m.modifier))) {
        for (const m of now) if (isDisablingModifier(m.modifier)) add(after, m);
      }
      // a focus is new unless the same one was already there: a `describe.only` at the same
      // depth, or the test's own `.only`. A new `.only` under an unchanged `describe.only` is
      // still new.
      for (const m of now) {
        if (m.modifier !== 'only') continue;
        if (was.some((w) => w.modifier === 'only' && originOf(w) === originOf(m))) {
          if (m.suite !== undefined) unchangedSuites.add(m.suite);
        } else {
          add(after, m);
        }
      }
    }
    // a new test does not weaken anything unless it is a .only that disables all the others, and
    // a `describe.only` that was already there does not become new because a child was added
    const suitesFocusedBefore = new Set<string>();
    for (const t of ctx.before.tests) {
      for (const m of modifiersOf(t)) {
        if (m.modifier === 'only' && m.suite !== undefined) suitesFocusedBefore.add(m.suite);
      }
    }
    for (const t of ctx.added) {
      for (const m of modifiersOf(t)) {
        if (m.modifier !== 'only') continue;
        const known =
          m.suite !== undefined &&
          (suitesFocusedBefore.has(m.suite) || unchangedSuites.has(m.suite));
        if (!known) add(t, m);
      }
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
