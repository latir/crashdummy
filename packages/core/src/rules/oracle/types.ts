import type { AstNode } from '../../parse/ast.js';
import type { TestFacts } from '../../parse/facts.js';
import type { Visitor } from '../../parse/walk.js';
import type { Finding, TestSummary } from '../../types.js';

export interface OracleMeta {
  evidence: Finding['evidence'];
  /** One sentence: what the rule catches. Shown by `crashdummy explain`. */
  summary: string;
  /** Points removed per finding. The scorer applies `cap` per rule per file. */
  penalty: number;
  cap: number;
  /** True: a finding fails the check whatever the score. */
  gate: boolean;
  /** Severity of a finding. Rules whose precision is not measured yet stay at `warn`. */
  severity: Finding['severity'];
}

/** What a rule sees of one test file. Everything but `file` is ready only when `finish` runs. */
export interface OracleContext {
  /** Repo-relative path. */
  file: string;
  source: string;
  summary(): TestSummary;
  facts(): readonly TestFacts[];
}

/** What a rule hands back from `create`. */
export interface OracleInstance {
  /** Runs on the shared walk, together with every other rule's and the summary builder's. */
  visitor?: Visitor;
  /** After the walk: the rule's findings. */
  finish(): Finding[];
}

export interface OracleRule {
  id: string;
  layer: 'oracle';
  meta: OracleMeta;
  create(ctx: OracleContext): OracleInstance;
}

export type { AstNode };
