import { describe, expect, test } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { createLattice, parseMatcherOverrides } from '../src/rules/lattice.js';

const m = (name: string, extra: object = {}) => ({ name, ...extra });

describe('unknown matchers without overrides', () => {
  const lattice = createLattice();
  test('are neutral: not weak, never weakened', () => {
    expect(lattice.resolveMatcher(m('toBeWithinRange'))).toMatchObject({
      known: false,
      strength: 2,
    });
    expect(lattice.isWeakMatcher(m('toBeWithinRange'))).toBe(false);
    expect(lattice.isWeakened(m('toEqual'), m('toBeWithinRange'))).toBe(false);
  });
});

describe('{ strength }', () => {
  const lattice = createLattice({
    toBeWithinRange: { strength: 3 },
    toBeTruthyish: { strength: 1 },
  });

  test('gives a custom matcher a strength', () => {
    expect(lattice.resolveMatcher(m('toBeWithinRange'))).toMatchObject({
      known: true,
      strength: 3,
    });
    expect(lattice.isWeakMatcher(m('toBeTruthyish'))).toBe(true);
  });

  test('is compared by strength against other chains', () => {
    expect(lattice.compareMatchers(m('toEqual'), m('toBeWithinRange'))).toBe('weaker');
    expect(lattice.compareMatchers(m('toBeWithinRange'), m('toBeDefined'))).toBe('weaker');
    expect(lattice.compareMatchers(m('toBeWithinRange'), m('toBeWithinRange'))).toBe('equal');
  });

  test('.not still caps strength', () => {
    expect(lattice.matcherStrength(m('toBeWithinRange', { negated: true }))).toBe(2);
  });

  test('does not leak into the default lattice', () => {
    expect(createLattice().resolveMatcher(m('toBeWithinRange')).known).toBe(false);
  });
});

describe('{ like }', () => {
  const lattice = createLattice({
    toMatchShape: { like: 'toMatchObject' },
    toBeNothing: { like: 'toBeNull' },
    toThrowSoftly: { like: 'toThrow@none' },
    toBeCalledTwice: { like: 'toBeCalledTimes' },
  });

  test('ranks the custom matcher at the built-in matcher position', () => {
    expect(lattice.compareMatchers(m('toMatchShape'), m('toMatchObject'))).toBe('equal');
    expect(lattice.compareMatchers(m('toEqual'), m('toMatchShape'))).toBe('weaker');
    expect(lattice.compareMatchers(m('toMatchShape'), m('toHaveProperty'))).toBe('weaker');
    expect(lattice.compareMatchers(m('toMatchShape'), m('toStrictEqual'))).toBe('stronger');
  });

  test('keeps the built-in matcher negation rules', () => {
    expect(lattice.isWeakMatcher(m('toBeNothing', { negated: true }))).toBe(true);
    expect(lattice.isWeakMatcher(m('toBeNothing'))).toBe(false);
  });

  test('can target an argument-specific built-in', () => {
    expect(lattice.matcherStrength(m('toThrowSoftly'))).toBe(2);
  });

  test('can target an alias of a built-in', () => {
    expect(lattice.compareMatchers(m('toBeCalledTwice'), m('toHaveBeenCalledTimes'))).toBe('equal');
  });
});

describe('overriding built-ins', () => {
  test('a user entry wins over the built-in one', () => {
    const lattice = createLattice({ toBeDefined: { strength: 2 } });
    expect(lattice.isWeakMatcher(m('toBeDefined'))).toBe(false);
    expect(createLattice().isWeakMatcher(m('toBeDefined'))).toBe(true);
  });

  test('an entry on an alias name is honored', () => {
    const lattice = createLattice({ toBeCalled: { strength: 4 } });
    expect(lattice.matcherStrength(m('toBeCalled'))).toBe(4);
    expect(lattice.matcherStrength(m('toHaveBeenCalled'))).toBe(2);
  });

  test('argument-specific entries only match that argument kind', () => {
    const lattice = createLattice({
      'toBeWithin@literal': { strength: 4 },
      toBeWithin: { strength: 2 },
    });
    expect(lattice.matcherStrength(m('toBeWithin', { arg: 'literal' }))).toBe(4);
    expect(lattice.matcherStrength(m('toBeWithin', { arg: 'other' }))).toBe(2);
  });

  test('expect.anything() still makes it existence-only', () => {
    const lattice = createLattice({ toBeWithinRange: { strength: 4 } });
    expect(lattice.isWeakMatcher(m('toBeWithinRange', { arg: 'anything' }))).toBe(true);
  });
});

describe('parseMatcherOverrides', () => {
  test('accepts valid config and undefined', () => {
    expect(parseMatcherOverrides(undefined)).toEqual({});
    expect(
      parseMatcherOverrides({
        a: { strength: 4 },
        b: { like: 'toEqual' },
        'c@none': { strength: 1 },
      }),
    ).toEqual({ a: { strength: 4 }, b: { like: 'toEqual' }, 'c@none': { strength: 1 } });
  });

  test.each([
    ['not an object', 'oops', /matchers must be an object/],
    ['array', [], /matchers must be an object/],
    ['entry not an object', { a: 3 }, /matchers\.a: expected/],
    ['entry null', { a: null }, /matchers\.a: expected/],
    ['strength out of range', { a: { strength: 5 } }, /matchers\.a: strength must be 1, 2, 3 or 4/],
    ['strength not an integer', { a: { strength: 2.5 } }, /strength must be/],
    ['strength as a string', { a: { strength: '3' } }, /strength must be/],
    ['both fields', { a: { strength: 3, like: 'toEqual' } }, /exactly one of/],
    ['neither field', { a: {} }, /exactly one of/],
    ['unknown field', { a: { strength: 3, weight: 1 } }, /unknown field 'weight'/],
    ['like not a string', { a: { like: 7 } }, /"like" must be a matcher name/],
    [
      'like not built in',
      { a: { like: 'toBeNope' } },
      /matchers\.a: 'toBeNope' is not a built-in matcher/,
    ],
    [
      'like another override',
      { a: { strength: 3 }, b: { like: 'a' } },
      /matchers\.b: 'a' is not a built-in/,
    ],
    ['bad arg suffix', { 'a@maybe': { strength: 3 } }, /matchers\.a@maybe: key must be/],
    ['whitespace in key', { 'a b': { strength: 3 } }, /key must be a matcher name/],
  ])('rejects %s', (_label, input, message) => {
    expect(() => parseMatcherOverrides(input)).toThrow(ConfigError);
    expect(() => parseMatcherOverrides(input)).toThrow(message);
  });
});
