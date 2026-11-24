/** Shared data model. See docs/technical-plan.md, "Data model". */

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

/** What changed: produced by any ChangeSource. The engine only ever sees this. */
export interface ChangedFile {
  /** Repo-relative, posix separators. */
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed';
  /** For renames. */
  previousPath?: string;
  /** New source text. Absent when deleted. */
  after?: string;
  /** Old text, or a stored summary in snapshot mode. */
  before?: string | TestSummary;
  /** Lines in `after` that were added or changed, when the source knows them. */
  changedLines?: LineRange[];
}

export interface CollectOptions {
  cwd: string;
  /** git: base ref. Default is the merge-base with `origin/HEAD`. */
  base?: string;
  /** files: explicit file list, relative to `cwd` or absolute. */
  files?: readonly string[];
  /** Replaces the default test file globs. */
  testGlobs?: readonly string[];
  /** `tests` (default) returns only test files. `all` also returns source files. */
  scope?: 'tests' | 'all';
}

export interface ChangeSource {
  name: 'git' | 'snapshot' | 'hook' | 'files' | 'dirs';
  /** Whether this source applies. Some sources look at the options (`--files`), others at `cwd`. */
  detect(cwd: string, opts?: Partial<CollectOptions>): Promise<boolean>;
  collect(opts: CollectOptions): Promise<ChangedFile[]>;
}

/** Compact, storable shape of one test file (the integrity layer diffs these). */
export interface TestSummary {
  hash: string;
  framework: 'vitest' | 'jest' | 'playwright' | 'node-test' | 'unknown';
  imports: string[];
  tests: TestCase[];
}

export interface TestCase {
  id: string;
  /** The test's own name, without the `describe` names around it. */
  title?: string;
  loc: { line: number; col: number };
  /** The modifier that applies to this test: its own, else the nearest one on a `describe`. */
  modifier?: 'skip' | 'only' | 'todo' | 'fixme' | 'fails';
  /**
   * Every modifier that applies, outermost first: those on the surrounding `describe`s and the
   * test's own. `modifier` keeps only the one that wins, so a `describe.only` over a test that is
   * already skipped would otherwise leave no trace. `loc` is where each was written.
   */
  modifiers?: {
    modifier: 'skip' | 'only' | 'todo' | 'fixme' | 'fails';
    loc: { line: number; col: number };
    /** For a modifier on a `describe`: that suite's name path. Missing for the test's own. */
    suite?: string;
  }[];
  timeoutMs?: number;
  matchers: MatcherUse[];
  bodyHash: string;
}

export interface MatcherUse {
  name: string;
  strength: 1 | 2 | 3 | 4;
  negated: boolean;
  subjectIsMock: boolean;
  /**
   * Where the matcher sits in the lattice once its argument is known (`toHaveText('x')` and
   * `toHaveText(/x/)` differ), so changes can be compared without resolving it again. Missing for
   * matchers the lattice does not know.
   */
  chain?: string;
  rank?: number;
}

/** Output of every rule. */
export interface Finding {
  /** For example `integrity/test-removed`. */
  ruleId: string;
  layer: 'integrity' | 'oracle' | 'flaky' | 'structure' | 'info' | 'coverage' | 'mutation';
  /** True fails the check regardless of score. */
  gate: boolean;
  evidence: 'strong' | 'moderate' | 'weak';
  severity: 'info' | 'warn' | 'error';
  /** Repo-relative path. */
  file: string;
  /**
   * 1-based. For findings about code that was removed (`integrity/test-removed`) this is the
   * position in the OLD version of the file, which is `previousPath` when the file was renamed.
   */
  loc?: { line: number; col: number };
  /** One line, agent-readable. */
  message: string;
  /** How to fix it. */
  hint?: string;
  /** Points removed from the file score. Gates are outside the score, so 0. */
  penalty: number;
}
