# Integrity gates

Integrity gates fail a change that weakens a test suite, whatever the score is. They compare a test file before and after the change. The evidence is strong for AI agents: in [ImpossibleBench (ICLR 2026)](https://proceedings.iclr.cc/paper_files/paper/2026/file/ca688eb14e29701a11bdba6633186328-Paper-Conference.pdf), models often reached green by editing the tests. People make these changes too, so every gate can be allowed with a reason.

| Gate                           | Fails when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrity/test-removed`       | A test is gone, was not renamed or moved, and the code it tested still exists. A removed `todo` does not count: it had no body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `integrity/modifier-added`     | A test that ran is now `skip`, `fixme` or `todo`, or a `.only` appeared (it silently turns off every other test). Every modifier on a test's path counts, not just the one that wins: a `describe.only` over tests that are already skipped is still a `.only`. A modifier written once on a `describe` is reported once, where it is written. A focus counts as new unless the same one was already there: a `describe.only` at the same depth of the test's path (renaming the suite does not make it new), or the test's own `.only`. `test.only` under an unchanged `describe.only` is new, a new test under an unchanged `describe.only` is not. Every new place is reported, so an override on a suite cannot hide the test's own `.only` or `.skip`. |     |
| `integrity/matcher-weakened`   | An assertion moved down the [matcher lattice](matchers.md), for example `toEqual` to `toBeTruthy`, or `toThrow('msg')` to `toThrow()`. Two negated assertions are not compared (negation turns the order around); positive to negated is weaker. Assertions cancel by where they sit in the lattice, not by how they are spelled, so aliases (`toBeCalledWith` and `toHaveBeenCalledWith`) are the same assertion.                                                                                                                                                                                                                                                                                                                                          |     |
| `integrity/assertions-dropped` | A test that still exists has fewer assertions than before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Renames come first

Before any gate runs, tests are matched across the change, so a rename is not a removal:

1. the same test id. When a title is repeated in a suite its tests are numbered in source order, which says nothing about which is which, so among tests that share a title identical bodies are matched first and the numbering only decides what is left,
2. the same body (a rename, or a move into another `describe` or another changed file),
3. a similar name, best match first (a rename plus an edit). Only the test's own title is compared, not the `describe` names around it, so two unrelated tests under one long suite name are not mistaken for one test. The pair is still judged by the other gates, so editing a test into a weaker one is not a way around them.

Matching is one-to-one. Steps 1 and 2 run across every changed file before step 3 runs in any. Within step 2, every file settles its own renames before any test crosses to another file, so the result does not depend on the order the files come in, and a test that moved is matched on its identical body before a similar name can take its place. It is still judged where it landed: moved and skipped is a skip.

## "Its source still exists"

Removing a test is fine when the code it tested was removed too. `integrity/test-removed` looks at the local modules the old test file imported (relative paths; packages such as `vitest` or `lodash/isEqual.js` are not local, whatever their ending). Only imports without an extension or with a JS/TS one are checked: an asset such as `./data.json` is not the code under test. It fires when at least one of them still exists, or when the file imported none that can be checked. Deleting a module and its test file together is not a finding.

## Allowing a change

```ts
// crashdummy-allow integrity/modifier-added: flaky on CI, tracked in the issue tracker
test.skip('adds', () => {
  /* ... */
});
```

- The directive must start its comment line (after whitespace or the `*` of a block comment). A comment that only mentions the syntax, like `// Example: crashdummy-allow ...`, is documentation and allows nothing.
- The reason is required, and it needs real words. A directive without one allows nothing and is a gate on its own (`integrity/allow-without-reason`).
- **Above code:** a comment on its own line covers the next line that has code, so other comments can sit in between. If code follows the comment on the same line (`/* note */ test.skip(...)`), that line is the target.
- **Trailing:** a comment after code on the same line covers that line only, never the next one.
- **At the top of the file** (before the first statement), a comment covers the whole file. That is the only way to allow `integrity/test-removed`, because the removed test is not in the new file.
- Several rules: `// crashdummy-allow integrity/matcher-weakened, integrity/assertions-dropped: covered by the contract test`.
- A rule that does not exist is reported as a warning, so a typo does not silently allow nothing.
- A deleted test file has no comment to write. Allow it with the `allow` option (the CLI will accept it as a commit trailer).
- Allowed findings are not lost: `checkIntegrity` returns them separately, with their reason.

## Files that do not parse

A file with a syntax error cannot be compared, and an empty list of tests must never look like "every test was removed". It gets `integrity/unparseable` instead: a gate with `onParseError: "fail"` (the default), a warning with `"warn"` (for per-edit hooks). If only the old version fails to parse, the file is treated as new and a note is added.
