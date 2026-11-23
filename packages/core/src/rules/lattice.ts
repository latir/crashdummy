import { ConfigError } from '../errors.js';
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
  /** `not.<matcher>` is an existence-only check (for example `not.toBeNull`). */
  existenceWhenNegated: boolean;
}

type Alias = string | { name: string; negated?: boolean };

const existenceOnlyWhenNegated = new Set<string>(data.negation.existenceOnly);
const index = new Map<string, Placement>();
for (const chain of data.chains) {
  chain.levels.forEach((level, rank) => {
    for (const key of level.matchers) {
      if (index.has(key)) throw new Error(`lattice.json: '${key}' appears in more than one place`);
      index.set(key, {
        chain: chain.id,
        rank,
        strength: level.strength as Strength,
        existenceWhenNegated: existenceOnlyWhenNegated.has(key),
      });
    }
  });
}

const aliases = data.aliases as Record<string, Alias>;
const NEGATED_MAX = data.negation.maxStrength as Strength;
const DEFAULT_STRENGTH = data.defaultStrength as Strength;

/**
 * A user-defined matcher, for custom matchers the lattice does not know (jest-extended, in-house
 * matchers). Either give it a strength, or rank it like a built-in matcher.
 */
export type MatcherOverride = { strength: Strength } | { like: string };

/** Keyed by matcher name, or `name@literal` / `name@other` / `name@none` for one argument kind. */
export type MatcherOverrides = Readonly<Record<string, MatcherOverride>>;

export interface Lattice {
  resolveMatcher(ref: MatcherRef): ResolvedMatcher;
  /** The 1-4 strength to store in `MatcherUse.strength`. */
  matcherStrength(ref: MatcherRef): Strength;
  /** True for existence-only checks such as `toBeTruthy`, `not.toBeNull` and `expect.anything()`. */
  isWeakMatcher(ref: MatcherRef): boolean;
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
  compareMatchers(before: MatcherRef | undefined, after: MatcherRef | undefined): Comparison;
  /** Used by `integrity/matcher-weakened`. */
  isWeakened(before: MatcherRef | undefined, after: MatcherRef | undefined): boolean;
}

const ARG_SUFFIX = /^(.+?)(?:@(literal|other|none))?$/;

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

function lookupIn(
  table: ReadonlyMap<string, Placement>,
  name: string,
  arg: ArgKind | undefined,
): Placement | undefined {
  if (arg !== undefined && arg !== 'anything') {
    const specific = table.get(`${name}@${arg}`);
    if (specific) return specific;
  }
  return table.get(name);
}

/** Build the placements for user overrides. `like` is resolved against the built-in lattice. */
function buildOverrides(overrides: MatcherOverrides): Map<string, Placement> {
  const custom = new Map<string, Placement>();
  for (const [key, override] of Object.entries(overrides)) {
    if ('strength' in override) {
      custom.set(key, {
        chain: `custom:${key}`,
        rank: 0,
        strength: override.strength,
        existenceWhenNegated: false,
      });
      continue;
    }
    const target = ARG_SUFFIX.exec(override.like);
    const alias = target ? canonical({ name: target[1]! }) : undefined;
    const arg = target?.[2] as ArgKind | undefined;
    const placed = alias ? lookupIn(index, alias.name, arg) : undefined;
    if (!placed)
      throw new ConfigError(`matchers.${key}: '${override.like}' is not a built-in matcher`);
    custom.set(key, placed);
  }
  return custom;
}

/** Create a lattice with optional user overrides. Overrides win over built-in entries. */
export function createLattice(overrides: MatcherOverrides = {}): Lattice {
  const custom = buildOverrides(overrides);

  function resolveMatcher(ref: MatcherRef): ResolvedMatcher {
    // User overrides are matched on the name as written, before alias resolution.
    const own = lookupIn(custom, ref.name, ref.arg);
    const { name, negated } = own
      ? { name: ref.name, negated: ref.negated === true }
      : canonical(ref);

    const argOverride =
      ref.arg === undefined ? undefined : data.argOverrides[ref.arg as 'anything'];
    if (argOverride) {
      return {
        strength: argOverride.strength as Strength,
        known: true,
        chain: argOverride.chain,
        rank: 0,
        negated,
      };
    }

    const placed = own ?? lookupIn(index, name, ref.arg);
    if (!placed) return { strength: DEFAULT_STRENGTH, known: false, negated };

    let strength = placed.strength;
    if (negated) {
      strength = placed.existenceWhenNegated ? 1 : (Math.min(strength, NEGATED_MAX) as Strength);
    }
    return { strength, known: true, chain: placed.chain, rank: placed.rank, negated };
  }

  function compareMatchers(
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

  return {
    resolveMatcher,
    matcherStrength: (ref) => resolveMatcher(ref).strength,
    isWeakMatcher(ref) {
      const r = resolveMatcher(ref);
      return r.known && r.strength === 1;
    },
    compareMatchers,
    isWeakened: (before, after) => compareMatchers(before, after) === 'weaker',
  };
}

/**
 * Validate the `matchers` key of the config file. Each entry is `{ "strength": 1-4 }` or
 * `{ "like": "<built-in matcher>" }`. Throws `ConfigError` with the offending key.
 */
export function parseMatcherOverrides(input: unknown): MatcherOverrides {
  if (input === undefined) return {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError('matchers must be an object');
  }
  const out: Record<string, MatcherOverride> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[^@\s]+(@(literal|other|none))?$/.test(key)) {
      throw new ConfigError(
        `matchers.${key}: key must be a matcher name, optionally followed by @literal, @other or @none`,
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ConfigError(
        `matchers.${key}: expected { "strength": 1-4 } or { "like": "<matcher>" }`,
      );
    }
    const entry = value as Record<string, unknown>;
    const unknownField = Object.keys(entry).find((k) => k !== 'strength' && k !== 'like');
    if (unknownField) throw new ConfigError(`matchers.${key}: unknown field '${unknownField}'`);
    const hasStrength = 'strength' in entry;
    const hasLike = 'like' in entry;
    if (hasStrength === hasLike) {
      throw new ConfigError(`matchers.${key}: give exactly one of "strength" or "like"`);
    }
    if (hasStrength) {
      const n = entry['strength'];
      if (n !== 1 && n !== 2 && n !== 3 && n !== 4) {
        throw new ConfigError(`matchers.${key}: strength must be 1, 2, 3 or 4`);
      }
      out[key] = { strength: n };
    } else {
      const like = entry['like'];
      if (typeof like !== 'string' || like === '') {
        throw new ConfigError(`matchers.${key}: "like" must be a matcher name`);
      }
      out[key] = { like };
    }
  }
  // Fail early on a `like` that does not exist, so the error names the config key.
  buildOverrides(out);
  return out;
}

const defaultLattice = createLattice();

export const resolveMatcher = defaultLattice.resolveMatcher;
export const matcherStrength = defaultLattice.matcherStrength;
export const isWeakMatcher = defaultLattice.isWeakMatcher;
export const compareMatchers = defaultLattice.compareMatchers;
export const isWeakened = defaultLattice.isWeakened;
