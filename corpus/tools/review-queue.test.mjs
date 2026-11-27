import { describe, expect, it } from 'vitest';
import { buildQueue, itemId, loadReasons } from './review-queue.mjs';

const W = 'oracle/weak-matcher';
const M = 'integrity/matcher-weakened';
const mk = (id, rules) => ({
  id,
  set: 'random',
  tests: [{ id: `${id}-t`, title: `${id} title`, rules }],
  removed: [],
});
const labelMap = (entries) => {
  const out = new Map();
  for (const [c, t, r, l] of entries) {
    if (!out.has(c)) out.set(c, new Map());
    if (!out.get(c).has(t)) out.get(c).set(t, new Map());
    out.get(c).get(t).set(r, l);
  }
  return out;
};
const all = (entries) => ({
  opus: labelMap(entries),
  sonnet: labelMap(entries),
  haiku: labelMap(entries),
});
const split = (c, r, labels) => ({
  opus: labelMap([[c, `${c}-t`, r, labels[0]]]),
  sonnet: labelMap([[c, `${c}-t`, r, labels[1]]]),
  haiku: labelMap([[c, `${c}-t`, r, labels[2]]]),
});
const key = (c, r) => `${c}|${c}-t|${r}`;

describe('buildQueue', () => {
  it('takes every integrity finding, whatever the models said', () => {
    const data = { cases: [mk('a', [M])] };
    const q = buildQueue({
      data,
      fired: new Map([[key('a', M), 'got weaker']]),
      round1: all([['a', 'a-t', M, 'no']]),
      round2: all([['a', 'a-t', M, 'no']]),
    });
    expect(q).toHaveLength(1);
    expect(q[0].why).toContain('integrity');
    expect(q[0].required).toBe(true);
    expect(q[0].engine).toBe('got weaker');
  });

  it('puts a split oracle finding in contested and a unanimous no in disputed', () => {
    const data = { cases: [mk('a', [W]), mk('b', [W])] };
    const q = buildQueue({
      data,
      fired: new Map([
        [key('a', W), 'x'],
        [key('b', W), 'y'],
      ]),
      round1: { opus: labelMap([]), sonnet: labelMap([]), haiku: labelMap([]) },
      round2: {
        opus: labelMap([
          ['a', 'a-t', W, 'yes'],
          ['b', 'b-t', W, 'no'],
        ]),
        sonnet: labelMap([
          ['a', 'a-t', W, 'no'],
          ['b', 'b-t', W, 'no'],
        ]),
        haiku: labelMap([
          ['a', 'a-t', W, 'no'],
          ['b', 'b-t', W, 'no'],
        ]),
      },
    });
    expect(q.find((i) => i.case === 'a').why).toEqual(['contested']);
    expect(q.find((i) => i.case === 'b').why).toEqual(['disputed']);
  });

  it('flags a problem a model saw that the engine missed, and a majority that flipped', () => {
    const data = { cases: [mk('a', [W]), mk('b', [W])] };
    const q = buildQueue({
      data,
      fired: new Map(),
      round1: all([
        ['a', 'a-t', W, 'no'],
        ['b', 'b-t', W, 'yes'],
      ]),
      round2: {
        opus: labelMap([
          ['a', 'a-t', W, 'yes'],
          ['b', 'b-t', W, 'no'],
        ]),
        sonnet: labelMap([
          ['a', 'a-t', W, 'no'],
          ['b', 'b-t', W, 'no'],
        ]),
        haiku: labelMap([
          ['a', 'a-t', W, 'no'],
          ['b', 'b-t', W, 'no'],
        ]),
      },
    });
    expect(q.find((i) => i.case === 'a').why).toEqual(['missed']);
    expect(q.find((i) => i.case === 'b').why).toEqual(['flipped']);
  });

  it('samples audits with a seed, caps them, and keeps them out of the required part', () => {
    const cases = Array.from({ length: 60 }, (_, i) => mk(`c${i}`, [W]));
    const clear = all(cases.map((c) => [c.id, `${c.id}-t`, W, 'no']));
    const args = { data: { cases }, fired: new Map(), round1: clear, round2: clear };
    const q = buildQueue(args);
    expect(q.filter((i) => i.why.includes('audit-clear'))).toHaveLength(20);
    expect(q.every((i) => !i.required)).toBe(true);
    expect(buildQueue(args).map((i) => i.id)).toEqual(q.map((i) => i.id));
    expect(buildQueue({ ...args, seed: 'other' }).map((i) => i.id)).not.toEqual(q.map((i) => i.id));
  });

  it('orders required items before audits and gives each item a stable id', () => {
    const cases = [mk('a', [M]), ...Array.from({ length: 30 }, (_, i) => mk(`c${i}`, [W]))];
    const clear = all(cases.slice(1).map((c) => [c.id, `${c.id}-t`, W, 'no']));
    const q = buildQueue({
      data: { cases },
      fired: new Map([[key('a', M), 'x']]),
      round1: clear,
      round2: clear,
    });
    expect(q[0].case).toBe('a');
    expect(q[0].id).toBe(itemId(key('a', M)));
    expect(q[0].id).toHaveLength(10);
  });

  it('attaches the one-line reasons models gave', () => {
    const data = { cases: [mk('a', [W])] };
    const reasons = {
      opus: new Map([[key('a', W), 'only checks it exists']]),
      sonnet: new Map(),
      haiku: new Map(),
    };
    const q = buildQueue({
      data,
      fired: new Map(),
      round1: all([]),
      round2: split('a', W, ['yes', 'no', 'no']),
      reasons,
    });
    expect(q[0].reasons).toEqual({ opus: 'only checks it exists' });
  });
});

describe('loadReasons', () => {
  it('returns nothing for a missing file', () => {
    expect(loadReasons('/nope/missing.json').size).toBe(0);
  });
});
