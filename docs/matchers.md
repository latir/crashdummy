# Matchers and the strength lattice

crashdummy ranks assertions by how much they check. `toStrictEqual({ total: 5 })` pins an exact value; `toBeTruthy()` only checks that something exists. The ranking drives two things:

- `integrity/matcher-weakened`: fails a change that swaps a stronger assertion for a weaker one.
- `oracle/weak-matcher`: flags tests whose only assertions are existence checks.

The ranking is data in [`packages/core/src/rules/lattice.json`](../packages/core/src/rules/lattice.json). The engine only sees a matcher name, whether it is negated, and what kind of argument it has, so it does not depend on any test framework. Framework syntax is the parser's job.

## How it works

- **Strength** is a coarse scale: 4 = exact value, 3 = structural or partial value, 2 = range, type or interaction, 1 = existence only.
- **Chains** are ordered lists, strongest first. Within a chain, moving down is a weakening, for example `toStrictEqual` to `toEqual` to `toMatchObject`.
- Across chains, only a clear drop in strength counts. Equal strength in different chains is "incomparable", and existence-only checks are all equal.
- `.not` caps strength at 2, and `not.toBeNull` / `not.toBeUndefined` are existence-only.
- `.resolves` and `.rejects` do not change strength.
- `expect.anything()` turns any matcher into an existence-only check.
- A matcher that is not in the lattice is neutral (strength 2). It is never reported as weak and never as weakened, so a gap in the lattice costs missed findings, not false alarms.

## Your own matchers

If your tests use custom matchers (for example from jest-extended or an in-house library), tell crashdummy how strong they are with the `matchers` key of `.crashdummy/config.json`:

```json
{
  "matchers": {
    "toBeWithinRange": { "strength": 3 },
    "toMatchShape": { "like": "toMatchObject" },
    "toBeNothing": { "like": "toBeNull" }
  }
}
```

Each entry is one of:

- `{ "strength": 1 | 2 | 3 | 4 }`: gives the matcher a strength. It is compared with other matchers by strength.
- `{ "like": "<built-in matcher>" }`: ranks it at the same position as a built-in matcher, so it compares correctly with the matchers around it and follows the same `.not` rules. `like` can name a built-in alias (`toBeCalledTimes`) or an argument-specific entry (`toThrow@none`). It cannot name another override.

Keys are matcher names, written as in the test. Add `@literal`, `@other` or `@none` to apply an entry only when the first argument is a literal, some other expression, or absent. Your entries win over built-in ones, so you can also re-rank a built-in matcher.

Invalid entries fail with an error that names the key, for example `matchers.toBeWithinRange: strength must be 1, 2, 3 or 4`.

> Reading the `matchers` key from the config file is wired up together with the rest of config loading. Until then, the same overrides are available from `@crashdummy/core` as `createLattice(parseMatcherOverrides(config.matchers))`.

## Adding a built-in matcher

If a matcher is common enough to ship by default, add it to `lattice.json` instead. See [CONTRIBUTING.md](../CONTRIBUTING.md#add-a-matcher-to-the-lattice).
