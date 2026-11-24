import type { Finding, TestCase, TestSummary } from '../../types.js';
import type { Lattice } from '../lattice.js';

/** A test in `before` matched to its counterpart in `after`. */
export interface Pair {
  before: TestCase;
  after: TestCase;
  /** How they were matched: same id, same body hash, or a similar name. */
  via: 'id' | 'body' | 'name';
}

export interface RuleMeta {
  evidence: Finding['evidence'];
  /** One sentence: what the rule catches. Shown by `crashdummy explain`. */
  summary: string;
}

/** Everything a rule needs to judge one changed test file. */
export interface IntegrityContext {
  /** The file as it is after the change (or its old path, when it was deleted). */
  file: string;
  before: TestSummary;
  after: TestSummary;
  /** Tests that exist on both sides, after rename detection. */
  pairs: readonly Pair[];
  /** Tests that are in `before` only, after rename detection. */
  removed: readonly TestCase[];
  /** Tests that are in `after` only, after rename detection. */
  added: readonly TestCase[];
  lattice: Lattice;
  /**
   * Whether the code the old file tested is still there: true when at least one local module it
   * imported still exists, or when it imported none that we can check.
   */
  sourceStillExists(): boolean;
}

export interface IntegrityRule {
  id: string;
  layer: 'integrity';
  meta: RuleMeta;
  /**
   * Which version of the file a finding's `loc` points into. Overrides written as comments live in
   * the new file, so they can only cover findings located in it.
   */
  side: 'before' | 'after';
  check(ctx: IntegrityContext): Finding[];
}
