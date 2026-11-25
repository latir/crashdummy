import { checkIntegrity, type AllowOption } from '../rules/integrity/index.js';
import { checkOracle, oracleRules } from '../rules/oracle/index.js';
import type { SummaryCache } from '../parse/index.js';
import type { Config } from '../config.js';
import type { ChangedFile, FileScore, Finding, Report, UnknownMatcher } from '../types.js';
import { DEFAULT_MIN_SCORE, staticScore, suiteScore, verdictOf, type RuleCaps } from './score.js';

export interface ScoreOptions extends Config {
  /** Repo root, for resolving imports. Default: the current directory. */
  cwd?: string;
  cache?: SummaryCache;
  /** Overrides that do not come from comments in the files, such as a commit trailer. */
  allow?: readonly AllowOption[];
}

const CAPS: RuleCaps = new Map(oracleRules.map((r) => [r.id, r.meta.cap]));

const unknownMatcherFinding = (file: string, name: string, count: number): Finding => ({
  ruleId: 'info/unknown-matcher',
  layer: 'info',
  gate: false,
  evidence: 'weak',
  severity: 'info',
  file,
  message: `matcher '${name}' is not in the strength lattice (${count} use${count === 1 ? '' : 's'}), so it is scored as neutral`,
  hint: `Add it under "matchers" in the config so its strength is known.`,
  penalty: 0,
});

/** Config can turn a rule off, or change what each of its findings removes. */
function applyRuleConfig(findings: Finding[], rules: Config['rules']): Finding[] {
  if (!rules) return findings;
  const out: Finding[] = [];
  for (const f of findings) {
    const setting = rules[f.ruleId];
    if (setting === 'off') continue;
    out.push(setting && f.penalty > 0 ? { ...f, penalty: setting.penalty } : f);
  }
  return out;
}

/**
 * Run tier 0 on a set of changed files and build the report: oracle rules on each file's new
 * text, integrity gates on the change, then scores, gates and the verdict.
 *
 * A file that does not parse is listed as such and gets no score. A deleted file has no score
 * either; only what its removal triggered is shown.
 */
export async function score(
  changes: readonly ChangedFile[],
  options: ScoreOptions = {},
): Promise<Report> {
  const started = performance.now();
  const cwd = options.cwd ?? process.cwd();
  const disabled = Object.entries(options.rules ?? {})
    .filter(([, v]) => v === 'off')
    .map(([id]) => id);
  const shared = {
    ...(options.matchers ? { matchers: options.matchers } : {}),
    ...(options.assertFunctionNames ? { assertFunctionNames: options.assertFunctionNames } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
  };

  const integrity = checkIntegrity(changes, {
    cwd,
    ...shared,
    ...(options.onParseError ? { onParseError: options.onParseError } : {}),
    ...(options.allow ? { allow: options.allow } : {}),
  });
  const integrityBy = new Map<string, Finding[]>();
  for (const f of integrity.findings) {
    const list = integrityBy.get(f.file);
    if (list) list.push(f);
    else integrityBy.set(f.file, [f]);
  }

  const files: FileScore[] = [];
  const tests = new Map<string, number>();
  const unknown = new Map<string, { count: number; files: Set<string> }>();

  for (const change of changes) {
    const extra = applyRuleConfig(integrityBy.get(change.path) ?? [], options.rules);
    integrityBy.delete(change.path);
    if (change.kind === 'deleted' || change.after === undefined) {
      files.push(fileEntry(change.path, 'deleted', extra));
      continue;
    }

    const { analysis, findings } = checkOracle(change.path, change.after, {
      resolve: { cwd },
      ...shared,
      disabled,
    });
    const first = analysis.errors[0];
    if (first) {
      const entry = fileEntry(change.path, 'unparseable', extra);
      entry.error = { line: first.line, col: first.col, message: first.message };
      files.push(entry);
      continue;
    }

    // matchers the lattice does not know, as `info` findings that never change a score
    const names = new Map<string, number>();
    for (const t of analysis.facts) {
      for (const a of t.assertions) {
        if (!a.known && !a.custom) names.set(a.matcher, (names.get(a.matcher) ?? 0) + 1);
      }
    }
    for (const [name, count] of names) {
      const entry = unknown.get(name) ?? { count: 0, files: new Set<string>() };
      entry.count += count;
      entry.files.add(change.path);
      unknown.set(name, entry);
      extra.push(unknownMatcherFinding(change.path, name, count));
    }

    const all = applyRuleConfig([...findings], options.rules).concat(extra);
    const count = analysis.summary.tests.length;
    tests.set(change.path, count);
    const entry = fileEntry(change.path, 'scored', all);
    const value = staticScore(all, count, CAPS);
    entry.score = value;
    entry.subscores.static = value;
    files.push(entry);
  }

  // findings about files that were not part of the list (a moved test's old path, say)
  for (const [path, list] of integrityBy) files.push(fileEntry(path, 'deleted', list));

  files.sort((a, b) => a.file.localeCompare(b.file));
  const unknownMatchers: UnknownMatcher[] = [...unknown]
    .map(([name, v]) => ({ name, count: v.count, files: [...v.files].sort() }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const suite = suiteScore(
    files.map((f) => ({
      ...(f.score !== undefined ? { score: f.score } : {}),
      tests: tests.get(f.file) ?? 0,
    })),
  );
  return {
    version: 1,
    tiersRun: [0],
    durationMs: Math.round(performance.now() - started),
    files,
    ...(suite !== undefined ? { suite: { score: suite } } : {}),
    verdict: verdictOf(files, { minScore }),
    ...(unknownMatchers.length > 0 ? { unknownMatchers } : {}),
  };
}

function fileEntry(file: string, status: FileScore['status'], findings: Finding[]): FileScore {
  const ordered = [...findings].sort(
    (a, b) =>
      Number(b.gate) - Number(a.gate) ||
      b.penalty - a.penalty ||
      (a.loc?.line ?? 0) - (b.loc?.line ?? 0),
  );
  return {
    file,
    status,
    findings: ordered,
    subscores: { static: 'unknown', coverage: 'unknown', mutation: 'unknown' },
    confidence: 'static-estimate',
    gates: ordered.filter((f) => f.gate),
  };
}
