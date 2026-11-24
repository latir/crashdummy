import { existsSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { ParseError } from '../../errors.js';
import {
  analyzeTestFile,
  resolveImport,
  summarizeTestFile,
  type ParsedFile,
  type SummaryCache,
} from '../../parse/index.js';
import type { ChangedFile, Finding, TestSummary } from '../../types.js';
import { createLattice, type MatcherOverrides } from '../lattice.js';
import { covers, parseAllowDirectives } from './allow.js';
import { gateFinding } from './finding.js';
import { assertionsDropped } from './assertions-dropped.js';
import { matcherWeakened } from './matcher-weakened.js';
import { modifierAdded } from './modifier-added.js';
import {
  DEFAULT_NAME_THRESHOLD,
  createPool,
  pairByBody,
  pairById,
  pairByName,
  toMatching,
  type Matching,
  type Pool,
} from './rename.js';
import { testRemoved } from './test-removed.js';
import type { IntegrityContext, IntegrityRule } from './types.js';

/**
 * A relative import we can check for existence: no extension, or a JS/TS one. Assets such as
 * `./data.json` or `./styles.css` are not the code under test, and the resolver only looks for
 * code, so they would always look "gone".
 */
const isCodeSpecifier = (spec: string): boolean => {
  const ext = extname(spec);
  return ext === '' || /^\.[cm]?[jt]sx?$/.test(ext);
};

export const integrityRules: readonly IntegrityRule[] = [
  testRemoved,
  modifierAdded,
  matcherWeakened,
  assertionsDropped,
];

/** An override that does not come from a comment in the file, such as a commit trailer. */
export interface AllowOption {
  rule: string;
  /** Limit it to one file. Without it, it covers every file. */
  file?: string;
  reason: string;
}

export interface IntegrityOptions {
  /** Repo root. Default: the current directory. */
  cwd?: string;
  /** User matcher overrides for the strength lattice. */
  matchers?: MatcherOverrides;
  assertFunctionNames?: readonly string[];
  /**
   * What an unparseable test file does: `fail` makes it a gate, `warn` only a warning. Default
   * `fail`. The caller picks `warn` for per-edit hooks, where half-written files are normal.
   */
  onParseError?: 'warn' | 'fail';
  /** For tests. Receives an absolute path. */
  exists?: (absolutePath: string) => boolean;
  allow?: readonly AllowOption[];
  cache?: SummaryCache;
  rules?: readonly IntegrityRule[];
  nameThreshold?: number;
}

export interface AllowedFinding {
  finding: Finding;
  reason: string;
  source: 'comment' | 'option';
}

export interface IntegrityResult {
  /** Gates, warnings and notes. A finding with `gate: true` fails the check. */
  findings: Finding[];
  /** Findings that a reasoned override allowed. Kept so output can show what was waved through. */
  allowed: AllowedFinding[];
}

const EMPTY: TestSummary = { hash: '', framework: 'unknown', imports: [], tests: [] };

interface Prepared {
  file: string;
  beforePath: string;
  before: TestSummary;
  after: TestSummary;
  parsedAfter: ParsedFile | undefined;
  pool: Pool;
  matching?: Matching;
  /**
   * Whether `before.imports` are specifiers as written (from source text) or repo paths already
   * resolved (from a stored summary). Only the first need to be told apart from packages.
   */
  importsRaw: boolean;
}

/**
 * Check a set of changed test files for changes that weaken the suite.
 *
 * Rename detection runs first, so a renamed or moved test is not a removed one. An unparseable
 * file is never compared: an empty summary would look like "every test was removed".
 */
export function checkIntegrity(
  changes: readonly ChangedFile[],
  options: IntegrityOptions = {},
): IntegrityResult {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const rules = options.rules ?? integrityRules;
  const lattice = createLattice(options.matchers ?? {});
  const failOnParseError = (options.onParseError ?? 'fail') === 'fail';
  const summaryOptions = {
    resolve: false as const,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.assertFunctionNames ? { assertFunctionNames: options.assertFunctionNames } : {}),
    ...(options.matchers ? { matchers: options.matchers } : {}),
  };

  const findings: Finding[] = [];
  const allowed: AllowedFinding[] = [];
  const prepared: Prepared[] = [];

  // 1. Summarize both sides of every file.
  for (const change of changes) {
    const file = change.path;
    const beforePath = change.previousPath ?? change.path;

    let before: TestSummary | undefined = change.kind === 'added' ? EMPTY : undefined;
    let importsRaw = true;
    if (before === undefined && change.before !== undefined) {
      if (typeof change.before === 'string') {
        try {
          before = summarizeTestFile(beforePath, change.before, summaryOptions);
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          before = EMPTY;
          findings.push(
            gateFinding('integrity/unparseable-before', file, {
              gate: false,
              severity: 'info',
              ...(error.errors[0]
                ? { loc: { line: error.errors[0].line, col: error.errors[0].col } }
                : {}),
              message: `the old version of ${beforePath} could not be parsed, so its tests were not compared`,
            }),
          );
        }
      } else {
        before = change.before;
        importsRaw = false;
      }
    }
    // nothing to compare against: the source did not give us the old version
    if (before === undefined) continue;

    let after: TestSummary = EMPTY;
    let parsedAfter: ParsedFile | undefined;
    if (change.kind !== 'deleted') {
      if (change.after === undefined) continue;
      const analysis = analyzeTestFile(file, change.after, summaryOptions);
      if (analysis.errors.length > 0) {
        const first = analysis.errors[0]!;
        findings.push(
          gateFinding('integrity/unparseable', file, {
            gate: failOnParseError,
            severity: failOnParseError ? 'error' : 'warn',
            loc: { line: first.line, col: first.col },
            message: `could not parse ${file} (line ${first.line}: ${first.message}), so it was not checked`,
            hint: 'Fix the syntax error, then run crashdummy again.',
          }),
        );
        continue;
      }
      after = analysis.summary;
      parsedAfter = analysis.file;
    }

    prepared.push({
      file,
      beforePath,
      before,
      after,
      parsedAfter,
      importsRaw,
      pool: createPool(before.tests, after.tests),
    });
  }

  // 2. Decide which tests are the same test, so a rename or a move is not a removal. Exact matches
  //    run across every file before any fuzzy one runs in any: a name that merely looks similar
  //    must not take a test before its exact twin in another file is found.
  const pools = prepared.map((p) => p.pool);
  for (const pool of pools) pairById(pool);
  // a file's own renames first, then moves between files, so the result does not depend on the
  // order the files come in
  for (const pool of pools) pairByBody(pool);
  for (const pool of pools) {
    pairByBody(
      pool,
      pools.filter((other) => other !== pool),
    );
  }
  for (const pool of pools) pairByName(pool, options.nameThreshold ?? DEFAULT_NAME_THRESHOLD);
  for (const p of prepared) p.matching = toMatching(p.pool);

  const knownRules = new Set(rules.map((r) => r.id));

  for (const p of prepared) {
    const sourceStillExists = (): boolean => {
      // Raw specifiers: only relative ones name a file of this repo; `vitest` and
      // `lodash/isEqual.js` are packages, whatever their ending. Stored summaries hold repo
      // paths already, so all of them count.
      const local = p.importsRaw
        ? p.before.imports.filter((s) => s.startsWith('.') && isCodeSpecifier(s))
        : p.before.imports;
      // nothing we can check: assume the code is still there
      if (local.length === 0) return true;
      return local.some((spec) =>
        p.importsRaw
          ? resolveImport(spec, p.beforePath, { cwd, exists }) !== undefined
          : exists(resolvePath(cwd, spec)),
      );
    };

    const ctx: IntegrityContext = {
      file: p.file,
      before: p.before,
      after: p.after,
      pairs: p.pool.pairs,
      removed: p.pool.removed,
      added: p.pool.added,
      lattice,
      sourceStillExists,
    };

    const directives = p.parsedAfter ? parseAllowDirectives(p.parsedAfter) : [];

    for (const rule of rules) {
      for (const finding of rule.check(ctx)) {
        const line = finding.loc?.line;
        const byComment = directives.find((d) => covers(d, rule.id, line, rule.side));
        if (byComment) {
          allowed.push({ finding, reason: byComment.reason!, source: 'comment' });
          continue;
        }
        const byOption = options.allow?.find(
          (a) =>
            a.rule === rule.id &&
            (a.file === undefined || a.file === finding.file) &&
            /[\p{L}\p{N}]/u.test(a.reason),
        );
        if (byOption) {
          allowed.push({ finding, reason: byOption.reason, source: 'option' });
          continue;
        }
        findings.push(finding);
      }
    }

    // An override must say why. Without a reason it allows nothing, and it is a finding itself.
    for (const d of directives) {
      const loc = { line: d.line, col: 1 };
      if (d.reason === undefined) {
        findings.push(
          gateFinding('integrity/allow-without-reason', p.file, {
            loc,
            message: 'crashdummy-allow needs a reason, so it does not allow anything',
            hint: 'Write why: `// crashdummy-allow <rule>: <reason>`.',
          }),
        );
      }
      if (d.rules.length === 0) {
        findings.push(
          gateFinding('integrity/allow-unknown-rule', p.file, {
            gate: false,
            severity: 'warn',
            loc,
            message: 'crashdummy-allow names no rule',
            hint: 'Write which rule to allow: `// crashdummy-allow integrity/test-removed: <reason>`.',
          }),
        );
      }
      for (const rule of d.rules) {
        // rules of other layers are checked by their own layer
        if (rule.startsWith('integrity/') && !knownRules.has(rule)) {
          findings.push(
            gateFinding('integrity/allow-unknown-rule', p.file, {
              gate: false,
              severity: 'warn',
              loc,
              message: `crashdummy-allow names an unknown rule '${rule}'`,
              hint: `Known integrity rules: ${[...knownRules].join(', ')}.`,
            }),
          );
        }
      }
    }
  }

  return { findings, allowed };
}

export { assertionsDropped, matcherWeakened, modifierAdded, testRemoved };
export { covers, parseAllowDirectives, type AllowDirective } from './allow.js';
export {
  matchTests,
  nameSimilarity,
  titleOf,
  DEFAULT_NAME_THRESHOLD,
  type Matching,
} from './rename.js';
export { weakenedAssertions } from './matcher-weakened.js';
export type { IntegrityContext, IntegrityRule, Pair, RuleMeta } from './types.js';
