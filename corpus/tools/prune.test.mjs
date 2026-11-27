import { describe, expect, test } from 'vitest';
import { dropFromSelection } from './prune.mjs';

describe('dropFromSelection', () => {
  test('removes the cases from both sets and records why', () => {
    const out = dropFromSelection({ seed: 's', random: ['a', 'b'], targeted: ['c', 'd'] }, [
      { id: 'b', repo: 'o/r', why: 'licence' },
      { id: 'c', repo: 'o/q', why: 'nested' },
    ]);
    expect(out.random).toEqual(['a']);
    expect(out.targeted).toEqual(['d']);
    expect(out.removed.map((r) => r.id)).toEqual(['b', 'c']);
    expect(out.seed).toBe('s');
  });

  test('keeps earlier removals', () => {
    const out = dropFromSelection(
      { random: ['a'], targeted: [], removed: [{ id: 'z', repo: 'o/r', why: 'x' }] },
      [{ id: 'a', repo: 'o/r', why: 'y' }],
    );
    expect(out.removed.map((r) => r.id)).toEqual(['z', 'a']);
  });
});
