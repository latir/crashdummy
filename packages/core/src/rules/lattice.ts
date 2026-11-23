import data from './lattice.json' with { type: 'json' };

/** Coarse strength: 4 = exact value, 1 = existence-only. Matches `MatcherUse.strength`. */
export type Strength = 1 | 2 | 3 | 4;

/** What the matcher's first argument looks like, as seen by the parser. */
export type ArgKind = 'literal' | 'other' | 'none' | 'anything';

export type Modifier = 'resolves' | 'rejects';

/** A matcher as it appears in a test: `expect(x).not.resolves.toBe(1)` -> toBe, negated. */
export interface MatcherRef {
  name: string;
  negated?: boolean;
  arg?: ArgKind;
  /** `.resolves` / `.rejects` unwrap the value but do not change how strong the check is. */
  modifiers?: readonly Modifier[];
}

export interface ResolvedMatcher {
  strength: Strength;
  /** False when the matcher is not in the lattice. It then gets `defaultStrength`. */
  known: boolean;
  chain?: string;
  /** Index of the level inside the chain; 0 is strongest. */
  rank?: number;
  negated: boolean;
}

export type Comparison = 'weaker' | 'equal' | 'stronger' | 'incomparable';

interface Placement {
  chain: string;
  rank: number;
  strength: Strength;
}

type Alias = string | { name: string; negated?: boolean };

const index = new Map<string, Placement>();
for (const chain of data.chains) {
  chain.levels.forEach((level, rank) => {
    for (const key of level.matchers) {
      if (index.has(key)) throw new Error(`lattice.json: '${key}' appears in more than one place`);
      index.set(key, { chain: chain.id, rank, strength: level.strength as Strength });
    }
  });
}

const aliases = data.aliases as Record<string, Alias>;
const existenceOnlyWhenNegated = new Set<string>(data.negation.existenceOnly);
const NEGATED_MAX = data.negation.maxStrength as Strength;
const DEFAULT_STRENGTH = data.defaultStrength as Strength;

function canonical(ref: MatcherRef): { name: string; negated: boolean } {
  const alias = aliases[ref.name];
  if (alias === undefined) return { name: ref.name, negated: ref.negated === true };
  if (typeof alias === 'string') return { name: alias, negated: ref.negated === true };
  // `assert.notEqual` is `assert.equal` negated; a second negation cancels out.
  return {
    name: alias.name,
    negated: alias.negated === true ? ref.negated !== true : ref.negated === true,
  };
}

function lookup(name: string, arg: ArgKind | undefined): Placement | undefined {
  if (arg !== undefined && arg !== 'anything') {
    const specific = index.get(`${name}@${arg}`);
    if (specific) return specific;
  }
  return index.get(name);
}

export function resolveMatcher(ref: MatcherRef): ResolvedMatcher {
  const { name, negated } = canonical(ref);

  const override = ref.arg === undefined ? undefined : data.argOverrides[ref.arg as 'anything'];
  if (override) {
    return {
      strength: override.strength as Strength,
      known: true,
      chain: override.chain,
      rank: 0,
      negated,
    };
  }

  const placed = lookup(name, ref.arg);
  if (!placed) return { strength: DEFAULT_STRENGTH, known: false, negated };

  let strength = placed.strength;
  if (negated) {
    strength = existenceOnlyWhenNegated.has(name)
      ? 1
      : (Math.min(strength, NEGATED_MAX) as Strength);
  }
  return { strength, known: true, chain: placed.chain, rank: placed.rank, negated };
}

/** The 1-4 strength to store in `MatcherUse.strength`. */
export function matcherStrength(ref: MatcherRef): Strength {
  return resolveMatcher(ref).strength;
}

/** True for existence-only checks such as `toBeTruthy`, `not.toBeNull` and `expect.anything()`. */
export function isWeakMatcher(ref: MatcherRef): boolean {
  const r = resolveMatcher(ref);
  return r.known && r.strength === 1;
}

/**
 * Compare `after` against `before` (the earlier assertion). `undefined` means "no assertion",
 * the bottom of the lattice.
 *
 * - Same chain and same polarity: ordered by position in the chain.
 * - Otherwise: ordered by coarse strength. Equal coarse strength across chains is
 *   `incomparable`, except existence-only checks, which are all equivalent.
 * - A matcher that is not in the lattice is `incomparable` to everything but itself, so an
 *   unknown matcher never trips `matcher-weakened`.
 */
export function compareMatchers(
  before: MatcherRef | undefined,
  after: MatcherRef | undefined,
): Comparison {
  if (before === undefined && after === undefined) return 'equal';
  if (before === undefined) return 'stronger';
  if (after === undefined) return 'weaker';

  const a = resolveMatcher(before);
  const b = resolveMatcher(after);
  if (!a.known || !b.known) {
    return canonical(before).name === canonical(after).name && a.negated === b.negated
      ? 'equal'
      : 'incomparable';
  }

  if (
    a.chain === b.chain &&
    a.negated === b.negated &&
    a.rank !== undefined &&
    b.rank !== undefined
  ) {
    if (a.rank === b.rank) return 'equal';
    return b.rank > a.rank ? 'weaker' : 'stronger';
  }
  if (a.strength === b.strength) return a.strength === 1 ? 'equal' : 'incomparable';
  return b.strength < a.strength ? 'weaker' : 'stronger';
}

/** Used by `integrity/matcher-weakened`. */
export function isWeakened(before: MatcherRef | undefined, after: MatcherRef | undefined): boolean {
  return compareMatchers(before, after) === 'weaker';
}
