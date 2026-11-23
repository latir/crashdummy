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
  loc: { line: number; col: number };
  modifier?: 'skip' | 'only' | 'todo' | 'fixme' | 'fails';
  timeoutMs?: number;
  matchers: MatcherUse[];
  bodyHash: string;
}

export interface MatcherUse {
  name: string;
  strength: 1 | 2 | 3 | 4;
  negated: boolean;
  subjectIsMock: boolean;
}
