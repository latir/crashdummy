# Scoring, verdicts and output

`crashdummy` scores each changed test file out of 100, decides a verdict, and prints it in the format you ask for. This page is what is built today (tier 0, static only). The plan's [scoring model](technical-plan.md#scoring-model-and-baseline) describes where it is going.

## The static score

A file starts at 100. Each rule takes points away; nothing adds points, and the number of assertions is never rewarded.

- **Per test, averaged.** A rule's share is the mean, over the file's tests, of what it took from each test. A bad test in a file of 20 costs a twentieth of what it would in a file of one, so file size alone does not change the score.
- **A finding about the whole file** (it names no test) counts in full.
- **A cap per rule.** One repeated pattern cannot zero a file. Caps are in the [oracle rules table](oracle.md).
- Integers, 0 to 100. No letter grades.

Gates are outside the score. A file can score 98 and still fail because a test has no assertion. Look at the gates first.

## The verdict and exit codes

| Verdict | When                                                           | Exit code                    |
| ------- | -------------------------------------------------------------- | ---------------------------- |
| `fail`  | A gate tripped, or a file scored below `minScore` (default 50) | 1                            |
| `warn`  | A warning is left, with no gate and no low score               | 0, or 2 with `--strict-warn` |
| `pass`  | Nothing else                                                   | 0                            |

Exit code 3 is a tool error: a bad config, an unknown option, no git repository. It is never a finding about your change. `info` findings never change the verdict.

## Files that cannot be checked

A file with a syntax error has no score, and is never counted as 0 or 100. It is listed as `unparseable` with the first error's line and column, and left out of the suite average. It fails the check by default; set `"onParseError": "warn"` for per-edit hooks, where half-written files are normal.

## Formats

`--format pretty` (default), `agent` or `json`.

- **`pretty`:** the score of each file and its top three findings. Colour is off for pipes and when `NO_COLOR` is set.
- **`agent`:** plain text, at most 25 lines, fixes phrased as instructions, no colours and no rule weights. A file that cannot be parsed is one line: `src/cart.test.ts: could not parse (line 12: Unexpected token). Fix the syntax error, then re-run.`
- **`json`:** the versioned `Report`. An unparseable file has `status: "unparseable"` and an `error`, and no `score`.

`sarif` and `md` come later.

## Config

`.crashdummy/config.json`, or the `"crashdummy"` key of `package.json`. Plain JSON. An unknown key is an error, so a typo cannot quietly change the verdict.

| Key                   | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| `minScore`            | A file below this fails. Integer 0 to 100, default 50.       |
| `rules`               | `{ "<rule>": "off" }` or `{ "<rule>": { "penalty": 3 } }`.   |
| `assertFunctionNames` | Custom assertion helpers. See [oracle rules](oracle.md).     |
| `matchers`            | Matcher strengths. See [matchers](matchers.md).              |
| `onParseError`        | `"warn"` or `"fail"` (default) for files with syntax errors. |
| `testGlobs`           | Replaces the default test file globs.                        |
| `maxDrop`             | Accepted now, used once there is a baseline.                 |

## Matchers the lattice does not know

They are scored as neutral. Each is shown as an `info/unknown-matcher` finding (no penalty), and `crashdummy explain matchers` lists them with a snippet to paste into `matchers`.

## `crashdummy explain <rule>`

Prints what the rule catches, why, the evidence behind it and an example fix.
