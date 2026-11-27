import { describe, expect, it } from 'vitest';
import { cohen, defaultsFrom, finalLabel, fleiss, measure, wilson } from './measure.mjs';

describe('wilson', () => {
  it('matches known intervals', () => {
    const { low, high } = wilson(18, 20);
    expect(low).toBeCloseTo(0.699, 2);
    expect(high).toBeCloseTo(0.972, 2);
  });
  it('is wide for a tiny sample and covers everything for none', () => {
    expect(wilson(1, 1).low).toBeLessThan(0.3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('kappa', () => {
  it('is 1 for agreement and 0 for chance', () => {
    expect(
      cohen([
        [true, true],
        [false, false],
        [true, true],
        [false, false],
      ]),
    ).toBe(1);
    expect(
      cohen([
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ]),
    ).toBeCloseTo(0);
    expect(cohen([])).toBeNull();
  });
  it('fleiss is 1 when all raters always agree', () => {
    expect(
      fleiss([
        [true, true, true],
        [false, false, false],
        [true, true, true],
      ]),
    ).toBe(1);
    expect(fleiss([])).toBeNull();
  });
});

describe('finalLabel', () => {
  it('a human yes or no is final whatever the models say', () => {
    expect(finalLabel('no', ['yes', 'yes', 'yes'])).toEqual({ label: 'no', source: 'human' });
    expect(finalLabel('yes', ['no', 'no', 'no'])).toEqual({ label: 'yes', source: 'human' });
  });
  it('a human unsure goes to the models majority, and a tie stays out', () => {
    expect(finalLabel('unsure', ['yes', 'yes', 'no'])).toEqual({ label: 'yes', source: 'models' });
    expect(finalLabel('unsure', ['yes', 'no', 'unsure'])).toBeNull();
  });
  it('without a human, only unanimous models decide', () => {
    expect(finalLabel(undefined, ['no', 'no', 'no'])).toEqual({
      label: 'no',
      source: 'models-unanimous',
    });
    expect(finalLabel(undefined, ['yes', 'yes', 'no'])).toBeNull();
    expect(finalLabel(undefined, ['yes', 'yes', undefined])).toBeNull();
  });
});

describe('measure', () => {
  const rule = 'oracle/weak-matcher';
  const mk = (id, set) => ({ id, set, tests: [{ id: 't', rules: [rule] }], removed: [] });
  const data = {
    rules: [rule],
    cases: [mk('a', 'random'), mk('b', 'random'), mk('c', 'targeted')],
  };
  const labelOf = (caseId, label) =>
    new Map([[caseId, new Map([['t', new Map([[rule, label]])]])]]);
  const merge = (...maps) => new Map(maps.flatMap((m) => [...m]));
  const unanimous = (labels) => {
    const m = merge(...Object.entries(labels).map(([c, l]) => labelOf(c, l)));
    return { opus: m, sonnet: m, haiku: m };
  };

  it('counts precision over decided findings and recall on the random set', () => {
    // a: real problem, found. b: real problem, missed. c: fired, not a problem.
    const labels = { human: undefined, models: unanimous({ a: 'yes', b: 'yes', c: 'no' }) };
    const fired = new Set([`a|t|${rule}`, `c|t|${rule}`]);
    const r = measure(data, labels, fired)[rule];
    expect(r.fired).toBe(2);
    expect(r.labelled).toBe(2);
    expect(r.precision).toBe(0.5);
    expect(r.randomSet.problems).toBe(2);
    expect(r.randomSet.caught).toBe(1);
    expect(r.randomSet.recall).toBe(0.5);
    expect(r.agreement.cohen['opus-sonnet']).toBe(1);
  });

  it('leaves out a finding nobody could decide', () => {
    const split = {
      opus: labelOf('a', 'yes'),
      sonnet: labelOf('a', 'no'),
      haiku: labelOf('a', 'yes'),
    };
    const r = measure(data, { human: undefined, models: split }, new Set([`a|t|${rule}`]))[rule];
    expect(r.fired).toBe(1);
    expect(r.labelled).toBe(0);
    expect(r.precision).toBeNull();
  });

  it('a human label overrides the models', () => {
    const labels = { human: labelOf('a', 'no'), models: unanimous({ a: 'yes' }) };
    const r = measure(data, labels, new Set([`a|t|${rule}`]))[rule];
    expect(r.precision).toBe(0);
    expect(r.groundTruth.human).toBe(1);
  });
});

describe('defaultsFrom', () => {
  const r = (labelled, precision) => ({ labelled, precision });
  it('is on only with enough findings and enough precision', () => {
    const d = defaultsFrom({
      few: r(5, 1),
      lowPrecision: r(30, 0.5),
      good: r(25, 0.96),
      none: r(0, null),
    });
    expect(d.few.default).toBe('off');
    expect(d.few.reason).toContain('only 5');
    expect(d.lowPrecision.default).toBe('off');
    expect(d.lowPrecision.reason).toContain('50%');
    expect(d.good.default).toBe('on');
    expect(d.none.default).toBe('off');
  });
});
