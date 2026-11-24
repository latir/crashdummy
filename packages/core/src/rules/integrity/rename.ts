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

/** The test's own name. Older summaries have no `title`: it is the end of the id then. */
export const titleOf = (t: TestCase): string => {
  if (t.title !== undefined) return t.title;
  const i = t.id.lastIndexOf(' > ');
  return i === -1 ? t.id : t.id.slice(i + 3);
};

/** The `describe` names around a test, as a string. */
const suiteOf = (t: TestCase): string =>
  t.id.slice(0, Math.max(0, t.id.length - titleOf(t).length));

/**
 * The tests of one file, before and after, and what has been matched so far. Matching happens in
 * steps so that the cheap, certain ones (same id, same body) can run across every file before the
 * fuzzy one (similar name) runs in any.
 */
export interface Pool {
  pairs: Pair[];
  /** Not matched yet, in `before` only. */
  removed: TestCase[];
  /** Not matched yet, in `after` only. */
  added: TestCase[];
}

export function createPool(before: readonly TestCase[], after: readonly TestCase[]): Pool {
  return { pairs: [], removed: [...before], added: [...after] };
}

function take(pool: Pool, b: TestCase, a: TestCase, via: Pair['via']): void {
  pool.pairs.push({ before: b, after: a, via });
  pool.removed = pool.removed.filter((t) => t !== b);
  pool.added = pool.added.filter((t) => t !== a);
}

/** The id without the ` #2` that numbers a repeated title. */
const baseId = (t: TestCase): string => {
  if (t.title === undefined || t.id.endsWith(t.title)) return t.id;
  return t.id.replace(/ #\d+$/, '');
};

/**
 * Step 1: the same id. When a title is repeated in a suite its tests are numbered in source
 * order, which says nothing about which is which: swapping two `test('x')` swaps their numbers.
 * So among tests that share a title, identical bodies are matched first and the numbering is
 * only used for what is left.
 */
export function pairById(pool: Pool): void {
  const groups = new Map<string, { before: TestCase[]; after: TestCase[] }>();
  const group = (t: TestCase): { before: TestCase[]; after: TestCase[] } => {
    const key = baseId(t);
    const g = groups.get(key) ?? { before: [], after: [] };
    groups.set(key, g);
    return g;
  };
  for (const t of pool.removed) group(t).before.push(t);
  for (const t of pool.added) group(t).after.push(t);

  for (const g of groups.values()) {
    if (g.before.length === 1 && g.after.length === 1) {
      // not repeated: the same test, whatever its number
      if (g.before[0]!.id === g.after[0]!.id) take(pool, g.before[0]!, g.after[0]!, 'id');
      continue;
    }
    // a repeated title: bodies first, then the numbering for whatever is left
    for (const b of g.before) {
      const a = g.after.find((t) => pool.added.includes(t) && t.bodyHash === b.bodyHash);
      if (a) take(pool, b, a, 'body');
    }
    for (const b of g.before) {
      if (!pool.removed.includes(b)) continue;
      const a = g.after.find((t) => pool.added.includes(t) && t.id === b.id);
      if (a) take(pool, b, a, 'id');
    }
  }
}

/**
 * Step 2: the same body, so the test was renamed or moved. A test is looked for in its own file
 * first, then in `others`; a match in another file is a pair of the file it moved to.
 */
export function pairByBody(pool: Pool, others: readonly Pool[] = []): void {
  for (const b of pool.removed) {
    for (const target of [pool, ...others]) {
      const a = target.added.find((t) => t.bodyHash === b.bodyHash);
      if (!a) continue;
      pool.removed = pool.removed.filter((t) => t !== b);
      target.added = target.added.filter((t) => t !== a);
      target.pairs.push({ before: b, after: a, via: 'body' });
      break;
    }
  }
}

/**
 * Step 3: a similar name, best match first. Only the test's own title is compared, not the
 * `describe` names around it: a long suite name shared by two unrelated tests must not make them
 * look like one test. Among equal names the pair in the same suite wins, then the one that
 * stayed closest to where it was.
 */
export function pairByName(pool: Pool, nameThreshold = DEFAULT_NAME_THRESHOLD): void {
  const candidates: { b: TestCase; a: TestCase; score: number; sameSuite: boolean; gap: number }[] =
    [];
  for (const b of pool.removed) {
    for (const a of pool.added) {
      const score = nameSimilarity(titleOf(b), titleOf(a));
      if (score >= nameThreshold) {
        candidates.push({
          b,
          a,
          score,
          sameSuite: suiteOf(b) === suiteOf(a),
          gap: Math.abs(b.loc.line - a.loc.line),
        });
      }
    }
  }
  candidates.sort(
    (x, y) => y.score - x.score || Number(y.sameSuite) - Number(x.sameSuite) || x.gap - y.gap,
  );
  for (const { b, a } of candidates) {
    if (pool.removed.includes(b) && pool.added.includes(a)) take(pool, b, a, 'name');
  }
}

export const toMatching = (pool: Pool): Matching => ({
  pairs: pool.pairs,
  removed: pool.removed,
  added: pool.added,
});

/**
 * Decide which tests of one file are the same test before and after, so a rename is not a
 * removal: the same id, then the same body, then a similar name. Matching is one-to-one. Whatever
 * is left over is removed or added.
 */
export function matchTests(
  before: readonly TestCase[],
  after: readonly TestCase[],
  nameThreshold = DEFAULT_NAME_THRESHOLD,
): Matching {
  const pool = createPool(before, after);
  pairById(pool);
  pairByBody(pool);
  pairByName(pool, nameThreshold);
  return toMatching(pool);
}
