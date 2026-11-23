import { describe, expect, test } from 'vitest';
import {
  compareMatchers,
  isWeakened,
  isWeakMatcher,
  matcherStrength,
  resolveMatcher,
  type MatcherRef,
} from '../src/rules/lattice.js';

const m = (name: string, extra: Omit<MatcherRef, 'name'> = {}): MatcherRef => ({ name, ...extra });

describe('plan lattice order', () => {
  // toStrictEqual > toEqual > toMatchObject > toHaveProperty > toBeDefined/toBeTruthy > none
  const equality = ['toStrictEqual', 'toEqual', 'toMatchObject', 'toHaveProperty', 'toBeDefined'];
  test.each(
    equality.flatMap((strong, i) => equality.slice(i + 1).map((weak) => [strong, weak] as const)),
  )('%s > %s', (strong, weak) => {
    expect(compareMatchers(m(strong), m(weak))).toBe('weaker');
    expect(compareMatchers(m(weak), m(strong))).toBe('stronger');
    expect(isWeakened(m(strong), m(weak))).toBe(true);
    expect(isWeakened(m(weak), m(strong))).toBe(false);
  });

  test('toBeDefined and toBeTruthy are equal', () => {
    expect(compareMatchers(m('toBeDefined'), m('toBeTruthy'))).toBe('equal');
  });

  test('any matcher > no assertion', () => {
    expect(compareMatchers(m('toEqual'), undefined)).toBe('weaker');
    expect(compareMatchers(undefined, m('toBeTruthy'))).toBe('stronger');
    expect(compareMatchers(undefined, undefined)).toBe('equal');
  });

  test('toBe(literal) > toBeCloseTo > toBeGreaterThan / toBeLessThan', () => {
    expect(compareMatchers(m('toBe', { arg: 'literal' }), m('toBeCloseTo'))).toBe('weaker');
    expect(compareMatchers(m('toBeCloseTo'), m('toBeGreaterThan'))).toBe('weaker');
    expect(compareMatchers(m('toBeGreaterThan'), m('toBeLessThan'))).toBe('equal');
    expect(compareMatchers(m('toBe', { arg: 'literal' }), m('toBeLessThan'))).toBe('weaker');
  });

  test('toThrow(Class or message) > toThrow()', () => {
    expect(compareMatchers(m('toThrow', { arg: 'other' }), m('toThrow', { arg: 'none' }))).toBe(
      'weaker',
    );
    expect(compareMatchers(m('toThrow', { arg: 'literal' }), m('toThrow', { arg: 'none' }))).toBe(
      'weaker',
    );
    expect(compareMatchers(m('toThrow', { arg: 'none' }), m('toThrow', { arg: 'literal' }))).toBe(
      'stronger',
    );
    expect(compareMatchers(m('toThrow', { arg: 'literal' }), m('toThrow', { arg: 'other' }))).toBe(
      'equal',
    );
  });
});

describe('strength values', () => {
  test.each([
    ['toStrictEqual', {}, 4],
    ['toEqual', {}, 4],
    ['toMatchObject', {}, 3],
    ['toBeTruthy', {}, 1],
    ['toBeDefined', {}, 1],
    ['toBe', { arg: 'literal' }, 4],
    ['toBe', { arg: 'other' }, 3],
    ['toBeGreaterThan', {}, 2],
    ['toHaveBeenCalled', {}, 2],
    ['toHaveBeenCalledWith', {}, 3],
  ] as const)('%s %j -> %i', (name, extra, strength) => {
    expect(matcherStrength(m(name, extra))).toBe(strength);
  });
});

describe('.not', () => {
  test('caps strength at 2', () => {
    expect(matcherStrength(m('toEqual', { negated: true }))).toBe(2);
    expect(matcherStrength(m('toBe', { arg: 'literal', negated: true }))).toBe(2);
  });

  test('not.toBeNull / not.toBeUndefined are existence-only', () => {
    expect(isWeakMatcher(m('toBeNull', { negated: true }))).toBe(true);
    expect(isWeakMatcher(m('toBeUndefined', { negated: true }))).toBe(true);
    expect(isWeakMatcher(m('toBeNull'))).toBe(false);
  });

  test('positive -> negated is weaker, negated -> positive is stronger', () => {
    expect(compareMatchers(m('toEqual'), m('toEqual', { negated: true }))).toBe('weaker');
    expect(compareMatchers(m('toEqual', { negated: true }), m('toEqual'))).toBe('stronger');
  });

  test('both negated compare along the chain', () => {
    expect(
      compareMatchers(m('toStrictEqual', { negated: true }), m('toBeDefined', { negated: true })),
    ).toBe('weaker');
  });
});

describe('.resolves / .rejects', () => {
  test('do not change strength or ordering', () => {
    const plain = m('toEqual');
    const resolved = m('toEqual', { modifiers: ['resolves'] });
    expect(matcherStrength(resolved)).toBe(matcherStrength(plain));
    expect(compareMatchers(plain, resolved)).toBe('equal');
    expect(
      compareMatchers(
        m('toThrow', { arg: 'other', modifiers: ['rejects'] }),
        m('toThrow', { arg: 'none', modifiers: ['rejects'] }),
      ),
    ).toBe('weaker');
    expect(compareMatchers(m('toEqual'), m('toBeTruthy', { modifiers: ['resolves'] }))).toBe(
      'weaker',
    );
  });
});

describe('expect.anything()', () => {
  test('makes any matcher existence-only', () => {
    expect(isWeakMatcher(m('toEqual', { arg: 'anything' }))).toBe(true);
    expect(
      compareMatchers(m('toEqual', { arg: 'literal' }), m('toEqual', { arg: 'anything' })),
    ).toBe('weaker');
    expect(compareMatchers(m('toBeTruthy'), m('toEqual', { arg: 'anything' }))).toBe('equal');
  });
});

describe('Jest and Vitest aliases', () => {
  test('resolve to the canonical matcher', () => {
    expect(compareMatchers(m('toBeCalledWith'), m('toHaveBeenCalledWith'))).toBe('equal');
    expect(
      compareMatchers(m('toThrowError', { arg: 'other' }), m('toThrow', { arg: 'other' })),
    ).toBe('equal');
    expect(compareMatchers(m('toHaveBeenCalledWith'), m('toBeCalled'))).toBe('weaker');
  });
});

describe('Playwright web-first matchers', () => {
  test('toHaveText(literal) > toContainText > toBeVisible', () => {
    expect(compareMatchers(m('toHaveText', { arg: 'literal' }), m('toContainText'))).toBe('weaker');
    expect(compareMatchers(m('toContainText'), m('toBeVisible'))).toBe('weaker');
    expect(compareMatchers(m('toHaveText', { arg: 'literal' }), m('toBeVisible'))).toBe('weaker');
  });

  test('state matchers are not weak', () => {
    for (const name of ['toBeVisible', 'toBeChecked', 'toBeEnabled', 'toHaveURL', 'toHaveCount']) {
      expect(isWeakMatcher(m(name)), name).toBe(false);
    }
  });
});

describe('node:assert', () => {
  test('strictEqual > equal > ok', () => {
    expect(compareMatchers(m('assert.strictEqual'), m('assert.equal'))).toBe('weaker');
    expect(compareMatchers(m('assert.deepStrictEqual'), m('assert.deepEqual'))).toBe('weaker');
    expect(compareMatchers(m('assert.equal'), m('assert.ok'))).toBe('weaker');
    expect(isWeakMatcher(m('assert.ok'))).toBe(true);
  });

  test('bare assert() is assert.ok', () => {
    expect(resolveMatcher(m('assert')).strength).toBe(1);
  });

  test('notStrictEqual is strictEqual negated', () => {
    const r = resolveMatcher(m('assert.notStrictEqual'));
    expect(r.negated).toBe(true);
    expect(r.strength).toBe(2);
    expect(compareMatchers(m('assert.strictEqual'), m('assert.notStrictEqual'))).toBe('weaker');
  });

  test('throws with an expectation > throws without', () => {
    expect(
      compareMatchers(m('assert.throws', { arg: 'other' }), m('assert.throws', { arg: 'none' })),
    ).toBe('weaker');
  });
});

describe('unknown matchers', () => {
  test('get the default strength and never read as weakened', () => {
    const custom = m('toBeWithinRange');
    expect(resolveMatcher(custom)).toMatchObject({ known: false, strength: 2 });
    expect(isWeakMatcher(custom)).toBe(false);
    expect(compareMatchers(m('toEqual'), custom)).toBe('incomparable');
    expect(compareMatchers(custom, m('toBeTruthy'))).toBe('incomparable');
    expect(compareMatchers(custom, custom)).toBe('equal');
    expect(isWeakened(m('toEqual'), custom)).toBe(false);
  });
});

describe('cross-chain at equal strength', () => {
  test('is incomparable, so it never trips matcher-weakened', () => {
    expect(compareMatchers(m('toEqual'), m('toBe', { arg: 'literal' }))).toBe('incomparable');
    expect(compareMatchers(m('toBeCloseTo'), m('toMatchObject'))).toBe('incomparable');
  });
});
