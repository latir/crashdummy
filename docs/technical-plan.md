# crashdummy — Technical Plan

Nov 21, 2026 · @Latir

## Overview

crashdummy is a fast, deterministic npm CLI that scores the quality of new and changed JS/TS tests, and flags changes that weaken a suite. It is aimed at agent-written specs, but scores any test the same way. `crashdummy` is named after the crash test dummy: it crashes your code on purpose and checks whether your tests notice.

**Goals**

- Score each changed test file out of 100, with the reason behind every point lost.
- Detect integrity regressions: removed tests, new skips, loosened matchers, timeout bumps.
- Keep a per-file baseline so the suite's quality can be tracked and ratcheted over time.
- Return compact, actionable output to any coding agent, so it fixes weak tests before a human reviews them.

**Non-goals**

- No LLM calls. Every result is reproducible from the code alone.
- No test running in tier 0. Coverage is read from existing reports. Mutation testing is opt-in.
- Not a linter replacement. Oxlint and ESLint results are optional inputs, never dependencies.

**Design principles**

1. **Fast by default.** Tier 0 finishes in under 300 ms on a typical PR, so it can run after every agent edit.
2. **Agnostic.** The core knows nothing about git, CI, Danger or any agent harness. Adapters plug those in.
3. **Model-agnostic.** It works the same for tests written by any model or harness, or by a person.
4. **Small dependency tree.** `oxc-parser` plus a few tiny utilities, so `npx` starts fast.
5. **Explainable.** Every point lost maps to a finding with a file, line and fix hint.

## Principles and evidence

A good test checks behavior strongly enough to fail when that behavior breaks. crashdummy ranks its signals by how well the research supports each one: mutation first, then oracle strength (assertions), then coverage. Style smells get little or no weight.

**What a high-quality test is**

1. **It has a real oracle.** It checks a specific expected outcome that comes from the requirement, not from the implementation ([Barr et al., TSE 2015](https://discovery.ucl.ac.uk/1471263/)).
2. **It is behavior-sensitive.** If the behavior breaks, the test fails. Mutation testing measures this directly, and pseudo-tested code shows what happens without it ([Niedermayr et al. 2016](https://teamscale.com/hubfs/Publications/2016-will-my-tests-tell-me-if-i-break-this-code.pdf)).
3. **It is structure-insensitive.** Refactors don't break it. It tests state through public APIs, not interactions with mocks ([Kent Beck, Test Desiderata](https://kentbeck.github.io/TestDesiderata/); [SWE at Google ch. 12](https://abseil.io/resources/swe-book/html/ch12.html)).
4. **It is deterministic and isolated.** It has no sleeps, no shared mock state and no order dependence. Async waits cause 45% of flaky tests ([Luo et al., FSE 2014](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf)), and 52% of flaky web UI tests ([Romano et al., ICSE 2021](https://arxiv.org/pdf/2103.02669v1)).
5. **It is readable and specific.** It covers one behavior, has a descriptive name, has no logic in the test, and prefers DAMP over DRY.
6. **It is honest.** It doesn't skip, focus, loosen or suppress its way to green. This matters most for AI agents.

**Evidence strength by signal**

| Signal | Evidence | Key sources |
| --- | --- | --- |
| Mutation score on changed lines | Strong | [Just et al., FSE 2014](https://homes.cs.washington.edu/~rjust/publ/mutants_real_faults_fse_2014.pdf): 73% of real faults coupled to mutants; [Google, ICSE 2021](https://arxiv.org/pdf/2103.07189): mutants would have flagged 70% of 1,502 high-priority bugs |
| Assertion presence and strength | Strong to moderate | [Zhang & Mesbah, FSE 2015](https://dl.acm.org/doi/10.1145/2786805.2786858); [Schuler & Zeller, ICST 2011](https://dl.acm.org/doi/10.1109/ICST.2011.32) |
| Integrity regressions (AI agents) | Strong | [ImpossibleBench, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/file/ca688eb14e29701a11bdba6633186328-Paper-Conference.pdf): GPT-5 cheated on 76% of impossible tasks, often by editing tests |
| Flaky patterns (sleeps, waits, shared state) | Strong | Luo 2014; Romano 2021; [JS-TOD](https://arxiv.org/html/2509.00466v1) |
| Patch coverage | Moderate as a floor, weak as quality | [Inozemtseva & Holmes, ICSE 2014](https://pdfs.semanticscholar.org/3b6c/26c317344ee98bf11a2ac744e6d8b2ae6f6d.pdf) |
| Mocking and implementation coupling | Moderate (practitioner consensus) | [SWE at Google ch. 13](https://abseil.io/resources/swe-book/html/ch13.html); [Testing Library](https://testing-library.com/docs/queries/about/); [Playwright best practices](https://playwright.dev/docs/best-practices) |
| Classic style smells | Weak, contested | [Spadini et al., ICSME 2018](https://research.tudelft.nl/en/publications/on-the-relation-of-test-smells-to-software-code-quality/) vs [Panichella et al., EMSE 2022](https://research.tudelft.nl/en/publications/test-smells-20-years-later-detectability-validity-and-reliability/) |

**How AI-written tests fail**

- **They enshrine bugs.** Across 145 PRs, 8–17% of LLM-generated tests asserted the faulty behavior, while only 2.4–4.8% revealed a fault (Charoosaei, Richter & Papadakis, arXiv 2610.11835, preprint). Only mutation testing or a spec-derived oracle catches this.
- **They pass but add nothing.** In Meta's TestGen-LLM, 57% of classes got a passing test, but only 25% got one that added coverage ([FSE 2024](https://dl.acm.org/doi/10.1145/3663529.3663839)).
- **They over-mock** and test the double instead of the code.
- **They tamper to reach green:** removing tests, skipping them, loosening matchers or raising timeouts. How often this happens depends heavily on the setup: 76% in ImpossibleBench, but 0–0.7% test-file edits on unambiguous tasks in EvilGenie (arXiv 2511.21654).

Each rule's docs page cites its evidence rating and source, so users can see why a point was lost.

## Architecture

The core is a pure pipeline, from changed files to a `Report`. Everything that touches git, CI or an agent lives outside it.

&#91;embedded content: specscore architecture · core engine with pluggable inputs and outputs\]

Change sources feed `ChangedFile[]` into the core. The scorer reads and writes the baseline, and reporters turn the `Report` into text that adapters deliver.

### Package layout

The repo is a pnpm workspace. Each package publishes on its own, so users only install what they use.

```
crashdummy/
  packages/
    core/      @crashdummy/core   engine, types, rules, reporters, change sources
    cli/       crashdummy         bin, arg parsing; bundled to one file
    mcp/       @crashdummy/mcp    optional MCP server
    action/    crashdummy/action  GitHub Action (composite, calls the CLI)
    danger/    danger-plugin-crashdummy
  fixtures/    per-rule valid/invalid files, before/after pairs
  corpus/      labeled real-world agent-written tests
  bench/       tinybench suites
```

Inside `core/src`: `sources/` (one file per change source), `parse/` (oxc wrapper and `TestSummary` builder), `rules/` (one file per rule), `tiers/` (coverage and mutation, lazy-loaded), `score/`, `baseline/`, `report/`.

## Data model

Every package shares one set of types in `@crashdummy/core`. The engine only ever sees `ChangedFile[]`, never git or a hook payload.

```ts
// What changed: produced by any ChangeSource
interface ChangedFile {
  path: string;                 // repo-relative, posix separators
  kind: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;        // for renames
  after?: string;               // new source text (absent when deleted)
  before?: string | TestSummary; // old text, or a stored summary in snapshot mode
  changedLines?: LineRange[];   // when the source knows them (git, hook)
}

interface ChangeSource {
  name: 'git' | 'snapshot' | 'hook' | 'files' | 'dirs';
  detect(cwd: string): Promise<boolean>;
  collect(opts: CollectOptions): Promise<ChangedFile[]>;
}

// Compact, storable shape of one test file (the integrity layer diffs these)
interface TestSummary {
  hash: string;                 // xxhash of source text
  framework: 'vitest' | 'jest' | 'playwright' | 'node-test' | 'unknown';
  imports: string[];            // resolved source modules under test
  tests: TestCase[];
}

interface TestCase {
  id: string;                   // describe path + name, e.g. 'cart > adds item'
  loc: { line: number; col: number };
  modifier?: 'skip' | 'only' | 'todo' | 'fixme' | 'fails';
  timeoutMs?: number;
  matchers: MatcherUse[];       // in order of appearance
  bodyHash: string;             // normalized AST hash, for duplicate detection
}

interface MatcherUse {
  name: string;                 // 'toEqual', 'toBeTruthy', 'toHaveBeenCalled'
  strength: 1 | 2 | 3 | 4;      // 4 = exact value, 1 = existence-only
  negated: boolean;
  subjectIsMock: boolean;       // expect(mockFn...) or expect(mockReturn)
}

// Output of every rule
interface Finding {
  ruleId: string;               // 'smell/tautological-mock', 'integrity/test-removed'
  layer: 'integrity' | 'oracle' | 'flaky' | 'structure' | 'info' | 'coverage' | 'mutation';
  gate: boolean;                // true = fails the check regardless of score
  evidence: 'strong' | 'moderate' | 'weak';
  severity: 'info' | 'warn' | 'error';
  file: string;
  loc?: { line: number; col: number };
  message: string;              // one line, agent-readable
  hint?: string;                // how to fix
  test?: string;                // TestCase.id, when the finding is about one test
  penalty: number;              // points removed from the file score
}

interface FileScore {
  file: string;
  status: 'scored' | 'unparseable' | 'deleted';  // unparseable: syntax error, no score
  score?: number;               // integer, 0–100. Absent unless status is 'scored'
  error?: { line: number; col: number; message: string };  // for 'unparseable'
  previous?: number;            // from baseline
  findings: Finding[];
  subscores: { static: number | 'unknown'; coverage: number | 'unknown'; mutation: number | 'unknown' };
  confidence: 'verified' | 'unverified' | 'static-estimate';
  gates: Finding[];             // tripped gates, reported outside the score
}

interface Report {
  version: 1;
  tiersRun: (0 | 1 | 2)[];
  durationMs: number;
  files: FileScore[];
  suite?: { score: number; previous?: number };
  verdict: 'pass' | 'warn' | 'fail';
  unknownMatchers?: { name: string; count: number; files: string[] }[];  // lattice gaps
}
```

`TestSummary` is what makes snapshot mode and the baseline possible: it stores just enough to diff tests without keeping the old source.

## Change sources

The CLI picks a source automatically in the order below. `--source <name>` forces one.

| Source | Detects | `before` comes from | Best for |
| --- | --- | --- | --- |
| `hook` | stdin JSON is present (`--stdin`) | Old text in the hook payload, else the snapshot | Per-edit checks inside an agent loop |
| `files` | `--files` or a list piped on stdin | Snapshot, if present | Custom scripts, monorepo task runners |
| `dirs` | `--base-dir` and `--head-dir` | Files in the base directory | Non-git VCS, CI artifacts |
| `git` | a `.git` folder and `--base` (default: merge-base with `origin/HEAD`) | `git show <base>:<path>` | PRs, pre-push, CI |
| `snapshot` | `.crashdummy/` exists, no git | Stored `TestSummary` | Projects without git |

**Implementation notes**

- **git:** shell out to `git diff --name-status -M --unified=0 <base>...HEAD` once, parse the hunks for `changedLines`, and batch `git cat-file --batch` for every `before` text. Don't use a git library: the git binary is faster and has no dependency cost.
- **hook:** each harness gets a small normalizer (`claude`, `codex`, `cursor`, `generic`) that maps its payload to `ChangedFile`. Unknown shapes fall back to `generic`, which reads `{ "files": ["path"] }`.
- **snapshot:** compare file hashes against `.crashdummy/baseline.json`. A missing entry means `added`, and an entry with no matching file means `deleted`.
- **Renames without git:** pair a deleted and an added file when 70% or more of their test ids match.
- **Test file detection:** default globs `**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cts,mts}` and `**/__tests__/**`, plus `e2e/**`. Override with `testGlobs` in config.
- **Source changes:** a changed non-test file maps to the test files that import it, using the reverse import index described under Performance. Those test files are re-scored, because their mutation and coverage signals may have changed.

## Analysis tiers and rule catalog

Three tiers trade speed for confidence. Tier 0 always runs. Tiers 1 and 2 run only when asked for or when their inputs exist.

| Tier | What it does | Inputs | Target time | Runs in |
| --- | --- | --- | --- | --- |
| 0 | Static smells and integrity, from the AST | Changed test files | < 300 ms | Every agent edit, pre-commit |
| 1 | Patch coverage of changed source lines | Existing `coverage-final.json` or `lcov.info` | < 1 s | Agent stop hook, pre-push, CI |
| 2 | Mutation score on changed source lines | StrykerJS, if installed | Time budget, default 90 s | Agent stop hook (opt-in), CI |

### Tier 0 gates: integrity (pass/fail, outside the score)

Integrity regressions are gates, not points: they fail the check with the reason shown, whatever the score. The evidence is strong for AI agents, and humans make these changes too. A deliberate change can be allowed with a reasoned override, `// crashdummy-allow <rule>: reason` or a `Crashdummy-Allow:` commit trailer.

| Gate | Signal (diff-based, needs `before`) | Default |
| --- | --- | --- |
| **`integrity/test-removed`** | A test id in `before` is missing from `after`, wasn't renamed, and its source file still exists | fail |
| **`integrity/modifier-added`** | New `.only`, `.skip`, `xit`, `describe.skip`, `test.fixme`, or `todo` replacing an implemented test | fail |
| **`integrity/matcher-weakened`** | An assertion moves down the strength lattice (below) | fail |
| **`integrity/assertions-dropped`** | A surviving test's assertion count drops | fail |
| `integrity/timeout-raised` | A test, describe or config timeout goes up, or `retries` is added | fail |
| `integrity/suppression-added` | New `@ts-ignore`, `@ts-expect-error`, `as any` or `eslint-disable` in a test file | fail |
| `integrity/expectation-rewritten` | A literal inside `expect(...)` changes in the same diff as the source line it covers | warn |
| `integrity/snapshot-bulk-rewrite` | Snapshot files rewritten in bulk alongside source changes | warn |

**Matcher strength lattice**, strongest first:

- `toStrictEqual` > `toEqual` > `toMatchObject` > `toHaveProperty` > `toBeDefined` / `toBeTruthy` > no assertion
- `toBe(literal)` > `toBeCloseTo` > `toBeGreaterThan` / `toBeLessThan`
- `toThrow(Class or message)` > `toThrow()`

The lattice is data, not code, in `rules/lattice.json`, so new matchers can be added without touching the engine.

### Tier 0 scored rules: oracle (highest static weight)

Penalties are per test, with a cap per rule per file. **Gate** means the rule also fails the check, because a test like that checks nothing at all.

| Rule | Signal | Evidence | Penalty / cap | Gate |
| --- | --- | --- | --- | --- |
| **`oracle/no-assertion`** | No `expect` / `assert` / `t.assert*`, after following local helpers one level deep. A function named `expectX` / `assertX` that cannot be followed (imported) counts by its name; other names go in `assertFunctionNames` | Strong | 15 / 30 | yes |
| **`oracle/tautological-assertion`** | `expect(true).toBe(true)`, `expect(x).toBe(x)`, literal compared with literal | Strong | 15 / 30 | yes |
| **`oracle/mocks-subject`** | `vi.mock` / `jest.mock` path resolves to the module under test. A partial mock (spreading the original) is only a warning | Moderate–strong | 15 / 30 | full mocks only |
| **`oracle/swallowed-async`** | Unawaited `.resolves` / `.rejects`, `expect` in `.then` without await or return, `done` misuse | Strong | 10 / 20 | yes |
| **`oracle/tautological-mock`** | Data flows from `mockReturnValue(X)` to `expect(...)` comparing against X, with no call to the code under test in between | Moderate | 12 / 24 | no |
| `oracle/from-sut` | The expected value is computed by calling the function under test | Moderate | 8 / 16 | no |
| **`oracle/weak-matcher`** | Only `toBeTruthy` / `toBeDefined` / `not.toBeNull` / `expect.anything()` on a value, with no stronger assertion on the same subject | Moderate | 5 / 15 | no |
| **`oracle/interaction-only`** | Every assertion is `toHaveBeenCalled*`. Suppressed when no return value is captured (void code under test) | Moderate | 6 / 18 | no |
| `oracle/snapshot-only` | The only assertion is a snapshot. +3 if it is over 40 lines | Moderate–weak | 5 / 15 | no |
| `oracle/conditional-assertion` | `expect` inside `if`, `switch`, a ternary, `catch` or a loop, with no `expect.assertions(n)`. Use `test.each` instead | Moderate | 6 / 18 | no |

### Tier 0 scored rules: determinism (mid weight)

| Rule | Signal | Evidence | Penalty / cap |
| --- | --- | --- | --- |
| **`flaky/sleep`** | `page.waitForTimeout`, `await new Promise(r => setTimeout(r, n))`, `sleep(n)` | Strong | 8 / 16 |
| `flaky/manual-ui-assertion` | `expect(await loc.isVisible())` and similar, instead of web-first `await expect(loc).toBeVisible()` | Strong | 6 / 18 |
| `flaky/force-action` | Playwright `{ force: true }`, which skips actionability checks | Moderate | 4 / 12 |
| `flaky/shared-mock-state` | Module-scope `spyOn` or mutable fixtures with no `restoreMocks` and no `afterEach` restore, or `useFakeTimers` with no `useRealTimers` | Moderate | 3 / 9 |

### Tier 0: structure and informational rules (low or zero weight)

| Rule | Signal | Evidence | Penalty / cap |
| --- | --- | --- | --- |
| `structure/impl-query` | `container.querySelector*`, CSS or XPath locators, `.nth()` / `.first()`. `getByTestId` is neutral | Moderate | 3 / 9 |
| `structure/duplicate-body` | Same normalized AST hash across tests. Near-duplicates (similarity above 0.9) are informational | Weak–moderate | 4 / 12 |
| `structure/vague-name` | Empty or generic names ("works", "test 1"), or names repeated across tests | Weak | 1 / 3 |
| `info/assertion-roulette`, `info/magic-number`, `info/eager-test` | Classic smells | Weak, contested | 0 (informational) |

Classic smells stay informational because their validity is contested: detectors disagree, and modern runners already report which assertion failed ([Panichella et al. 2022](https://research.tudelft.nl/en/publications/test-smells-20-years-later-detectability-validity-and-reliability/)).

Rename detection runs before `test-removed`, matching on `bodyHash` and then on name similarity, so a renamed test is not counted as removed. Every suppression comment requires a reason. A suppression without one is itself a finding.

### Tier 1: coverage

- Read Istanbul JSON or lcov, whichever exists, and auto-detect them under `coverage/`. Never run tests.
- Patch coverage = covered changed executable lines / changed executable lines, for the sources each test file imports. With per-test data it's attributed to test files; otherwise it's a PR-level metric.
- Coverage is a **floor, not a quality score**: an uncovered changed line is definitely untested, but high coverage proves little once suite size is controlled.
- If the report is older than the newest changed file, or its commit doesn't match, the sub-score is **unknown**. Never treat it as 0, and never as a pass.

### Tier 2: mutation

Tier 2 follows the design of Google's diff-based mutation testing, which ran over 6 years and 662,584 changes ([Petrović et al., ICSE 2021](https://arxiv.org/pdf/2103.07189)):

- **Mutate only changed lines that are covered**, with one mutant per line. On more than 90% of lines, every mutant shares the same fate.
- **Show at most 7 surviving mutants per file.** Suppress mutants in logging and `console` calls, which aren't useful.
- **Default mode is extreme mutation:** the Descartes/pseudo-tested approach, which removes a changed function's body or returns a constant. That's about 2 mutants per function, so it's fast, and it catches tests that execute code without checking it.
- **Deep mode** (`--mutation full`) runs StrykerJS operators on changed lines, under `--budget` (default 90 s).
- **Mutation score** = killed / (killed + survived). Mutants that time out or never get evaluated are reported as unknown, never as killed.
- **Survivors are suggestions,** with a location and the mutation, for example "`>` to `>=` on line 41 survived". Equivalent mutants add noise, so a survivor isn't treated as a definite bug.
- If StrykerJS isn't installed, crashdummy prints a one-line install hint and the sub-score is unknown. Stryker is never bundled.

## Scoring model and baseline

Each file gets three sub-scores out of 100: Static (tier 0), Coverage (tier 1) and Mutation (tier 2). These combine into one score out of 100. Gates sit outside the number: a file can score 85 and still fail because a test was removed.

**Static sub-score:** starts at 100. Rule penalties are computed per test and averaged across the file's tests, so file size alone doesn't change the score. Each rule has a cap per file, so one repeated pattern can't zero a file. Raw finding counts are always shown.

**Combining, depending on which data exists:**

| Data available | Weights | Label shown |
| --- | --- | --- |
| Static + coverage + mutation | Mutation 50%, Static 30%, Coverage 20% | verified |
| Static + coverage | Static 65%, Coverage 35% | unverified (no mutation) |
| Static only | Static 100% | static estimate |

Mutation gets the most weight because it has the strongest evidence and is the hardest metric to game. Static keeps a large share because it's the only tier that sees determinism problems and integrity changes. A file without mutation data never looks as good as a verified one, because its label always shows.

**Display:** scores are plain integers out of 100, shown with the change since the baseline and the sub-scores, e.g. `72/100 (−14) · static 80 · cov 91 · mut 58`. There are no letter grades.

**Files that cannot be checked.** A file with a syntax error has no AST, so no rule runs on it. It gets **no score** (never 0, never 100), is left out of the suite average, and is listed as `unparseable` with the first error's line and column. In `fail` mode (the default) it fails the check through `integrity/unparseable`; in `warn` mode it only warns. `onParseError` in config chooses the mode.

**Unrecognised matchers.** A matcher the strength lattice does not know is scored as neutral. The scorer collects them, shows them as `info/unknown-matcher` findings (no penalty, never a gate) and lists them in `Report.unknownMatchers`. Matchers the user configured under `matchers` are not counted.

**Verdict:**

- `fail`: any gate tripped (integrity rules, `no-assertion`, `tautological-assertion`, full `mocks-subject`, `swallowed-async`), a file below `minScore` (default 50), or a drop from the baseline larger than `maxDrop` (default 10 points).
- `warn`: any `warn` finding, or a drop within the tolerance.
- `pass`: anything else.

**Suite score:** the average file score, weighted by how many source lines each test file covers. Without coverage data, weight by test count. A suite of tiny tests can't outweigh one big, important file.

**Guarding against gaming (Goodhart's law):** agents optimize whatever they're measured on, and ImpossibleBench shows them special-casing and monkey-patching to pass. So:

- Gates are non-negotiable without a reasoned override.
- Assertion *count* is never rewarded. The score only penalizes weak or tautological assertions, because adding meaningless assertions is trivial.
- The `agent` format explains findings but never prints rule weights.
- Unknown stays unknown. A stale coverage report or a mutation timeout never counts as a pass.

**Calibration:** the weights above are judgment calls based on evidence strength, not fitted to data. No study has fitted penalties for JS test rules. Severity thresholds get calibrated as percentile bands on an OSS JS/TS corpus, following [Spadini et al., MSR 2020](https://sback.it/publications/msr2020.pdf), and precision is published per rule.

### Baseline layout

The baseline uses one small JSON file per test file, so parallel PRs rarely touch the same file and merge conflicts stay rare:

```
.crashdummy/
  config.json            # optional; also read from package.json "crashdummy"
  baseline/
    src__cart__cart.test.ts.json
    e2e__checkout.spec.ts.json
  cache/                 # gitignored: parse and coverage caches
```

```json
{
  "v": 1,
  "file": "src/cart/cart.test.ts",
  "score": 86,
  "key": { "test": "9f2c…", "sources": { "src/cart/cart.ts": "41ab…" } },
  "summary": { "framework": "vitest", "tests": [ /* TestSummary.tests, compacted */ ] },
  "signals": { "patchCoverage": 0.92, "mutationScore": 0.71 },
  "updatedAt": "2026-11-21"
}
```

**Rules**

- `key` combines the test file's hash with the hashes of the source files it imports. If any hash changes, the stored score is stale and gets recomputed.
- `crashdummy baseline update` writes the files. `--ratchet` writes only scores that improved, which suits the main branch in CI.
- `storage: "artifact"` in config keeps the baseline out of the repo. CI uploads and downloads `.crashdummy/baseline` as a build artifact.
- When there's no baseline yet, the first run seeds it and reports no ratchet findings.

## CLI, config and output

### Commands

```
crashdummy [check]            # default: tier 0 on changed tests
  --base <ref>               # git base (default: merge-base with origin/HEAD)
  --source <git|snapshot|hook|files|dirs>
  --files <paths...> | --stdin
  --tier <0|1|2>             # highest tier to run (default 0)
  --coverage <path>          # coverage report for tier 1
  --budget <seconds>         # tier 2 time cap (default 90)
  --format <pretty|agent|json|sarif|md>
  --all                      # score every test file, not just changed ones
crashdummy baseline update [--ratchet]
crashdummy explain <ruleId>   # what the rule catches + how to fix
crashdummy init [--agent claude|codex|cursor|generic] [--lefthook] [--husky]
```

Exit codes: 0 = pass, 1 = fail, 2 = warn (only with `--strict-warn`), 3 = tool error. Agent hooks need these to be stable.

### Config

Config is plain JSON, in `.crashdummy/config.json` or the `"crashdummy"` key of `package.json`. It's JSON rather than a TS config so crashdummy never has to load a TS loader at startup.

```json
{
  "testGlobs": ["**/*.{test,spec}.{ts,tsx}"],
  "rules": { "smell/vague-name": "off", "smell/weak-matcher": { "penalty": 5 } },
  "minScore": 65,
  "maxDrop": 10,
  "onParseError": "fail",
  "assertFunctionNames": ["expectValid", "check*"],
  "matchers": { "toBeWithinRange": { "strength": 3 } },
  "storage": "repo",
  "linterInputs": ["oxlint.json"]
}
```

### Output formats

| Format | For | Shape |
| --- | --- | --- |
| `pretty` | Humans in a terminal | Score per file out of 100, top 3 findings each, colored with `picocolors` |
| `agent` | Any coding agent | Plain text, at most 25 lines, imperative fixes, no colors or box drawing |
| `json` | Adapters and scripts | The `Report` type, stable and versioned |
| `sarif` | GitHub code scanning, other CI tools | SARIF 2.1.0, one result per finding |
| `md` | PR comments (Danger, Action) | Table of files, scores and deltas, with collapsed details |

Example `agent` output:

```
crashdummy: FAIL (2 files)
src/cart/cart.test.ts  58/100 (was 84) · static 70 · cov 88 · mut 41
  - line 14 'adds item': only asserts the mock you set up. Assert cart.total instead.
  - line 31: test 'rejects negative qty' was removed. Restore it or explain why.
  - mutant survived: cart.ts:41 '>' to '>='. Add a boundary test for qty === 0.
Run `npx crashdummy explain <rule>` for details.
```

`agent` output is the most important format. Keep it short, specific, and phrased as instructions.

## Adapters

Each adapter is a thin package or a template written by `crashdummy init`. Each one either calls the CLI or imports `@crashdummy/core`. None of them adds logic to the core.

| Adapter | Package or file | Calls | Tier | Notes |
| --- | --- | --- | --- | --- |
| Agent post-edit hook | `.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json` | `crashdummy --source hook --stdin --format agent` | 0 | Runs after each edit to a test file. Non-blocking: it adds context for the agent rather than stopping it |
| Agent stop hook | same files | `crashdummy --tier 1 --format agent` (`--tier 2` opt-in) | 1–2 | Blocks "done" on `fail` and sends the findings back to the agent |
| AGENTS.md snippet | appended by `init` | instruction text only | any | Works in harnesses without hooks (Aider, Cline, others) |
| MCP server | `@crashdummy/mcp` | `scoreTests`, `explainRule`, `getBaseline` tools | 0–2 | Optional, stdio transport, built on the official MCP SDK |
| Git hooks | Lefthook and husky snippets | `crashdummy` pre-commit, `--tier 1` pre-push | 0–1 | Backstop that catches tests from any harness, or from people |
| GitHub Action | `crashdummy/action` | `--format sarif` + `--format md` | 0–2 | Uploads SARIF, posts or updates one sticky PR comment |
| Danger plugin | `danger-plugin-crashdummy` | `@crashdummy/core` API → `markdown()` / `fail()` | 0–1 | For teams that already use Danger |
| Programmatic API | `@crashdummy/core` | `score(changes, opts): Promise<Report>` | any | For Vitest plugins, custom CI and other tools |

**Hook design rules**

- Keep the per-edit hook under 500 ms total, including Node startup. That's why the CLI is bundled and its dependencies are minimal.
- Run the post-edit hook only on test files and their direct source files. Anything else exits 0 immediately.
- The stop hook allows at most 2 blocking retries per session, keyed by a hash of the findings, so a stuck agent can't loop forever.
- Write hook configs as merges: `init` never overwrites existing hooks, and prints a diff before writing anything.

## Performance and engineering practices

The budget: under 300 ms from CLI start to output for a 10-file tier 0 run on a laptop, and under 2 s for 500 files with `--all`. CI fails the build if a benchmark regresses by more than 15%.

**Startup**

- Ship one bundled ESM file built with tsdown, with `oxc-parser` as the only external native dependency. Use no dynamic `import()` on the hot path.
- Lazy-load tier 1, tier 2, SARIF and MCP code, so tier 0 never pays for them.
- Target Node 20+ only, with no polyfills. Use `node:` built-ins for fs, crypto, child\_process and worker\_threads.

**Parsing and analysis**

- Parse each file once with `oxc-parser`. Every rule is a visitor registered on one shared AST walk, so there are N rules and still only 1 traversal.
- Use no type information and no TypeScript compiler. Resolve imports with a small resolver that handles relative paths, `tsconfig` `paths` and package `exports`, and leaves anything else unresolved.
- Hash with `node:crypto` (sha1, truncated), or `xxhash-wasm` if profiling shows hashing matters.
- Use `worker_threads` only past about 50 files. Below that, worker startup costs more than it saves.

**Caching**

- Store a parse cache in `.crashdummy/cache/summaries.json`, keyed by content hash and holding `TestSummary` results. Unchanged files are never parsed again.
- Build a reverse import index (source to test files) during `--all` or `baseline update`, then update it incrementally.
- Cache the parsed coverage map, keyed by the coverage file's mtime and size.

**Code practices**

- Strict TypeScript, Vitest for the tool's own tests, Biome or Oxlint plus Prettier for its lint and format.
- Each rule is one file exporting `{ id, layer, meta, create(ctx) }`, with fixtures next to it. Adding a rule never touches the engine.
- Use Changesets for versioning, and publish with npm provenance from GitHub Actions.
- Keep the dependency count tiny and audit it in CI: fail if production dependencies exceed 5.

## Testing strategy

A test-quality tool has to be trusted, so its false-positive rate is the metric that matters most. Target under 1 in 20 findings being wrong on the real-world corpus.

- **Rule fixtures:** each rule has `valid/` and `invalid/` fixture files. An `invalid` fixture's comments mark the expected findings, like `// expect: smell/no-assertion`.
- **Integrity pairs:** `before.test.ts` and `after.test.ts` fixture pairs for each integrity rule, including tricky renames and reordered tests.
- **Real-world corpus:** collect 50+ agent-written test files from public repos, labeled by hand as good or weak. Track precision and recall per rule in CI, and never ship a rule below 90% precision on it.
- **Golden reports:** snapshot the `json` and `agent` output for 3 sample repos (Vitest + React, Jest + Node, Playwright e2e) to catch accidental format changes.
- **Adapter smoke tests:** feed recorded hook payloads from each harness through `--source hook --stdin` and assert on the `ChangedFile[]` produced.
- **Benchmarks:** run `tinybench` on 10, 100 and 500 files in CI, compared with the main branch.
- **Dogfooding:** crashdummy runs on its own test suite, with `--ratchet` on main.

**Prior-art benchmark:** before release, run [SNUTS.js](https://github.com/Jhonatanmizu/snuts.js-core) (28 JS test-smell detectors) on the same corpus and compare false positives rule by rule. Publish precision per rule, since [Panichella et al.](https://research.tudelft.nl/en/publications/test-smells-20-years-later-detectability-validity-and-reliability/) showed smell detectors often disagree with human judgment.

## Milestones

Each milestone ships something usable on its own, so the project stays valuable even through long breaks. No dates are set: it moves at side-project pace.

&#91;embedded content: specscore roadmap · 5 milestones with exit gates\]

M1 is the only hard part to get right. After it, every milestone is additive: new sources, adapters or tiers plug into the same engine.

**M1 first tasks**

- [ ] Pick and reserve the npm name and GitHub org
- [ ] Scaffold the pnpm workspace, tsdown bundle, Vitest and Changesets
- [ ] `parse/`: oxc-parser wrapper and `TestSummary` builder for Vitest and Jest
- [ ] `sources/git` and `sources/files`
- [ ] Matcher strength lattice as data (`rules/lattice.json`)
- [ ] Integrity gates: test-removed, modifier-added, matcher-weakened, assertions-dropped, with rename detection
- [ ] Oracle rules: no-assertion, tautological-assertion, mocks-subject, swallowed-async, tautological-mock, weak-matcher, interaction-only
- [ ] Scorer (static sub-score, per-test normalization, caps, gates), plus `pretty`, `agent` and `json` reporters
- [ ] Collect and label the first 50-file corpus, then measure precision per rule
- [ ] Benchmark harness and the 300 ms budget check

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| False positives make people disable the tool | High | Precision gate on the corpus, a conservative MVP rule set, per-rule `off`, and suppression comments that require a reason |
| Scores get gamed by agents or people | High | Gates outside the score, mutation weighted heaviest, assertion count never rewarded, weights not shown to agents |
| Weights aren't empirically fitted | Medium | Label them as defaults, calibrate on the corpus, publish per-rule precision |
| Mutation evidence is mostly Java/C; JS validation is thin | Medium | Survivors shown as suggestions, extreme mode by default, unknown on timeout |
| No type info means heuristic `weak-matcher` and `mocks-subject` | Medium | Keep them at warning severity until measured; downgrade partial mocks |
| Agent hook schemas change | Medium | Isolated normalizers per harness, a `generic` fallback, recorded payload fixtures |
| Codecov, an agent vendor or Vitest ships a test quality score | Medium | Stay open source, diff-scoped and agent-agnostic; offer the core API so others can build on it |
| `oxc-parser` AST changes between versions | Low | Pin a minor range and keep one internal AST adapter layer that rules use |

**Open questions**

- [ ] Name decided: `crashdummy` (free on npm, with no lookalike package). Still to reserve: the npm package, the `@crashdummy` scope and the GitHub org (CAL-35).
- [ ] Should the static rules also ship as an Oxlint JS plugin, once Oxlint's plugin API is stable?
- [ ] Override format: inline comment only, or commit trailer too?
- [ ] Which coverage format is the default for Vitest (v8 or istanbul) when both are configured?
- [ ] License: MIT (most adoption) or Apache-2.0 (patent grant)?
- [ ] Should existing integrity tools (Kinnard's auditor, tampercheck) be imported as optional inputs?
