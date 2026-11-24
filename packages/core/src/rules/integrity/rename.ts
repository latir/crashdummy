import type { TestCase } from '../../types.js';
import type { Pair } from './types.js';

export interface Matching {
  pairs: Pair[];
  /** In `before` only. */
  removed: TestCase[];
  /** In `after` only. */
  added: TestCase[];
}

/** Names below this similarity are different tests. */
export const DEFAULT_NAME_THRESHOLD = 0.6;

/** 1 for identical strings, 0 for nothing in common. Case-insensitive Levenshtein ratio. */
export function nameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x.charCodeAt(i - 1) === y.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}

/**
 * Decide which tests are the same test before and after, so a rename is not a removal.
 *
 * 1. Same id.
 * 2. Same body hash: the test was renamed or moved, and its body did not change.
 * 3. Similar name, best match first: the test was renamed and edited. The pair is still judged by
 *    the other gates, so editing a test into a weaker one is not a way around them.
 *
 * Matching is one-to-one. Whatever is left over is removed or added.
 */
export function matchTests(
  before: readonly TestCase[],
  after: readonly TestCase[],
  nameThreshold = DEFAULT_NAME_THRESHOLD,
): Matching {
  const pairs: Pair[] = [];
  const unmatchedBefore = new Set(before);
  const unmatchedAfter = new Set(after);
  const take = (b: TestCase, a: TestCase, via: Pair['via']): void => {
    pairs.push({ before: b, after: a, via });
    unmatchedBefore.delete(b);
    unmatchedAfter.delete(a);
  };

  const byId = new Map(after.map((t) => [t.id, t] as const));
  for (const b of before) {
    const a = byId.get(b.id);
    if (a && unmatchedAfter.has(a)) take(b, a, 'id');
  }

  for (const b of before) {
    if (!unmatchedBefore.has(b)) continue;
    const a = after.find((t) => unmatchedAfter.has(t) && t.bodyHash === b.bodyHash);
    if (a) take(b, a, 'body');
  }

  const candidates: { b: TestCase; a: TestCase; score: number; gap: number }[] = [];
  for (const b of unmatchedBefore) {
    for (const a of unmatchedAfter) {
      const score = nameSimilarity(b.id, a.id);
      if (score >= nameThreshold) {
        candidates.push({ b, a, score, gap: Math.abs(b.loc.line - a.loc.line) });
      }
    }
  }
  // best name first; among equals, the one that stayed closest to where it was
  candidates.sort((x, y) => y.score - x.score || x.gap - y.gap);
  for (const { b, a } of candidates) {
    if (unmatchedBefore.has(b) && unmatchedAfter.has(a)) take(b, a, 'name');
  }

  return {
    pairs,
    removed: before.filter((t) => unmatchedBefore.has(t)),
    added: after.filter((t) => unmatchedAfter.has(t)),
  };
}
