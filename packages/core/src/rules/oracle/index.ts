import { resolveImports } from '../../parse/resolve.js';
import { analyzeTestFile, type AnalyzeOptions, type Analysis } from '../../parse/index.js';
import type { Visitor } from '../../parse/walk.js';
import type { Finding } from '../../types.js';
import { interactionOnly } from './interaction-only.js';
import { mocksSubject } from './mocks-subject.js';
import { noAssertion } from './no-assertion.js';
import { swallowedAsync } from './swallowed-async.js';
import { tautologicalAssertion } from './tautological-assertion.js';
import { tautologicalMock } from './tautological-mock.js';
import type { OracleRule } from './types.js';
import { weakMatcher } from './weak-matcher.js';

export const oracleRules: readonly OracleRule[] = [
  noAssertion,
  tautologicalAssertion,
  swallowedAsync,
  mocksSubject,
  tautologicalMock,
  weakMatcher,
  interactionOnly,
];

export interface OracleOptions extends Omit<AnalyzeOptions, 'visitors'> {
  /** Rule ids to leave out. */
  disabled?: readonly string[];
}

export interface OracleResult {
  analysis: Analysis;
  findings: Finding[];
}

/**
 * Parse a test file once and run every oracle rule on the same walk as the summary builder.
 * A file that does not parse has no findings: report it as unparseable instead.
 */
export function checkOracle(
  file: string,
  source: string,
  options: OracleOptions = {},
  rules: readonly OracleRule[] = oracleRules,
): OracleResult {
  let analysis: Analysis | undefined;
  const ctx = {
    file,
    source,
    summary: () => analysis!.summary,
    facts: () => analysis!.facts,
    mocks: () => analysis!.mocks,
    resolve: (spec: string) =>
      options.resolve === false
        ? spec
        : (resolveImports([spec], file, options.resolve ?? { cwd: process.cwd() })[0] ?? spec),
  };
  const active = rules.filter((r) => !options.disabled?.includes(r.id));
  const instances = active.map((r) => r.create(ctx));
  const visitors: Visitor[] = instances.flatMap((i) => (i.visitor ? [i.visitor] : []));
  analysis = analyzeTestFile(file, source, { ...options, visitors });
  if (analysis.errors.length > 0) return { analysis, findings: [] };
  const findings = instances.flatMap((i) => i.finish());
  findings.sort(
    (a, b) =>
      (a.loc?.line ?? 0) - (b.loc?.line ?? 0) ||
      (a.loc?.col ?? 0) - (b.loc?.col ?? 0) ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { analysis, findings };
}

export type { OracleRule, OracleContext, OracleMeta, OracleInstance } from './types.js';
export {
  noAssertion,
  tautologicalAssertion,
  swallowedAsync,
  mocksSubject,
  tautologicalMock,
  weakMatcher,
  interactionOnly,
};
