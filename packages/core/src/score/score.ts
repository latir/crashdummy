import type { FileScore, Finding, Verdict } from '../types.js';

/** What a rule may remove from one file's static score, by rule id. */
export type RuleCaps = ReadonlyMap<string, number>;

/**
 * The static sub-score of one file: 100, minus what each rule removes, as an integer.
 *
 * Penalties are computed per test and averaged over the file's tests, so file size alone does not
 * change the score: a rule's share is the mean over the tests of what it took from each test. A
 * finding that is about the whole file (it names no test) counts in full. Each rule is capped, so
 * one repeated pattern cannot zero a file. Assertion count is never part of this: only findings
 * remove points, nothing adds them.
 */
export function staticScore(
  findings: readonly Finding[],
  testCount: number,
  caps: RuleCaps = new Map(),
): number {
  const tests = Math.max(1, testCount);
  const perTest = new Map<string, number>();
  const wholeFile = new Map<string, number>();
  const seen = new Set<string>();
  for (const f of findings) {
    if (f.penalty <= 0) continue;
    seen.add(f.ruleId);
    const into = f.test === undefined ? wholeFile : perTest;
    const key = f.test === undefined ? f.ruleId : `${f.ruleId}\0${f.test}`;
    into.set(key, (into.get(key) ?? 0) + f.penalty);
  }
  let removed = 0;
  for (const rule of seen) {
    let sum = 0;
    for (const [key, value] of perTest) if (key.startsWith(`${rule}\0`)) sum += value;
    const raw = sum / tests + (wholeFile.get(rule) ?? 0);
    removed += Math.min(caps.get(rule) ?? Infinity, raw);
  }
  return Math.max(0, Math.min(100, Math.round(100 - removed)));
}

export interface VerdictOptions {
  /** A file scoring below this fails. Default 50. */
  minScore?: number;
}

export const DEFAULT_MIN_SCORE = 50;

/**
 * `fail`: a gate tripped, or a file scored below `minScore`. `warn`: a warning is left. Otherwise
 * `pass`. Findings with `info` severity never change the verdict.
 */
export function verdictOf(files: readonly FileScore[], options: VerdictOptions = {}): Verdict {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  let warn = false;
  for (const file of files) {
    if (file.gates.length > 0) return 'fail';
    if (file.status === 'scored' && file.score !== undefined && file.score < minScore) {
      return 'fail';
    }
    if (file.findings.some((f) => f.severity !== 'info')) warn = true;
  }
  return warn ? 'warn' : 'pass';
}

/** Stable exit codes: hooks and CI rely on them. 0 pass, 1 fail, 2 warn (`strictWarn` only). */
export const EXIT = { pass: 0, fail: 1, warn: 2, error: 3 } as const;

export function exitCodeOf(verdict: Verdict, strictWarn = false): number {
  if (verdict === 'fail') return EXIT.fail;
  if (verdict === 'warn' && strictWarn) return EXIT.warn;
  return EXIT.pass;
}

/**
 * The suite score: the mean of the files that have one, weighted by test count so a handful of
 * tiny files cannot outweigh one large one. Unparseable and deleted files are left out: they have
 * no score, and are never counted as 0 or 100.
 */
export function suiteScore(
  files: readonly { score?: number; tests: number }[],
): number | undefined {
  let weight = 0;
  let total = 0;
  for (const f of files) {
    if (f.score === undefined) continue;
    const w = Math.max(1, f.tests);
    weight += w;
    total += f.score * w;
  }
  return weight === 0 ? undefined : Math.round(total / weight);
}
