import { describe, expect, it } from 'vitest';
import { expand, validate } from './labels.mjs';

const data = {
  cases: [
    {
      id: 'c1',
      tests: [{ id: 't1', rules: ['oracle/weak-matcher', 'oracle/no-assertion'] }],
      removed: [{ id: 'gone', rules: ['integrity/test-removed'] }],
    },
  ],
};

describe('validate', () => {
  it('accepts a complete, well formed file', () => {
    const labels = {
      labeller: 'x',
      cases: {
        c1: {
          file: 'weak',
          tests: {
            t1: { yes: ['oracle/weak-matcher'], reason: { 'oracle/weak-matcher': 'exists only' } },
            gone: {},
          },
        },
      },
    };
    const r = validate(data, labels);
    expect(r.errors).toEqual([]);
    expect(r.labelled).toBe(2);
    expect(r.missing).toEqual([]);
  });

  it('rejects a rule that does not apply, a missing reason and a bad file quality', () => {
    const labels = {
      labeller: 'x',
      cases: { c1: { file: 'ok', tests: { t1: { yes: ['integrity/test-removed'] } } } },
    };
    const text = validate(data, labels).errors.join('\n');
    expect(text).toContain('"file" must be');
    expect(text).toContain('does not apply');
    expect(text).toContain('needs a reason');
  });

  it('reports tests not yet labelled, and unknown cases and tests', () => {
    const r = validate(data, {
      labeller: 'x',
      cases: { nope: { file: 'good' }, c1: { file: 'good', tests: { t9: {} } } },
    });
    expect(r.errors.join('\n')).toContain('unknown case nope');
    expect(r.errors.join('\n')).toContain('unknown test "t9"');
    expect(r.missing).toEqual(['c1/t1', 'c1/gone']);
  });
});

describe('expand', () => {
  it('turns unlisted rules into no and keeps reasons', () => {
    const out = expand(data, {
      labeller: 'x',
      cases: {
        c1: {
          file: 'good',
          tests: {
            t1: { unsure: ['oracle/no-assertion'], reason: { 'oracle/no-assertion': 'helper' } },
          },
        },
      },
    });
    expect(out.cases.c1.tests.t1).toEqual({
      'oracle/weak-matcher': { label: 'no' },
      'oracle/no-assertion': { label: 'unsure', reason: 'helper' },
    });
    expect(out.cases.c1.tests.gone).toBeUndefined();
  });
});

describe('removed cases', () => {
  it('a label file may still mention a case that was taken out of the corpus', () => {
    const withRemoved = { ...data, removed: ['old'] };
    const labels = { labeller: 'x', cases: { old: { file: 'good', tests: { t: {} } } } };
    expect(validate(withRemoved, labels).errors).toEqual([]);
    expect(validate(data, labels).errors.join('\n')).toContain('unknown case old');
  });
});
