# Labeling guide

How to decide whether a crashdummy rule is **right** about a test. Read this before labelling, whether you are a person or a model. Everyone uses the same definitions.

## What you are labelling

Each corpus case is one test file written or changed by an AI coding agent. Cases that have a previous version also carry the diff.

You label **per test, per rule**, not per file. For every test in the case and every rule below, answer one question:

> Does this test have this problem?

Answer from the test code alone. You do not see what crashdummy reported. Findings are hidden on purpose so they cannot bias you.

| Answer    | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `yes`     | The test has the problem the rule describes.                               |
| `no`      | The test does not have it.                                                 |
| `unsure`  | You cannot tell from the code shown. Use sparingly; say why in the reason. |

Also give each **file** a quality of `good` or `weak`: would you trust this file to catch a regression? This is a sanity check on the whole score, not tied to one rule.

Add a one-line `reason` for every `yes` and every `unsure`. A reason makes adjudication fast.

## Principles

1. **Ask what would happen if the code were wrong.** A test is healthy when a plausible bug in the code under test makes it fail. Every rule below is a way that cannot happen.
2. **Judge the behaviour, not the style.** `toBeTruthy()` on a boolean the code returns is fine. The same matcher on an object that could be any object is not.
3. **Context beats syntax.** Read the surrounding test before you decide. A helper called `expectValid(x)` may assert inside.
4. **Do not reward volume.** More `expect` calls never make a test better. Count nothing.
5. **When the intent is clearly smoke or snapshot-style by design, say `no`.** A test named "renders without crashing" that only renders is honest about its scope. The rule is about tests that claim more than they check.

## Rule definitions

### `oracle/no-assertion`

**Problem:** the test cannot fail because it checks nothing.

- `yes`: the body calls code and never asserts, expects, or verifies. Awaiting a promise that could reject counts as a check only if the test is documented as "does not throw".
- `no`: an assertion is reached, including through a helper that asserts, `expect.assertions`, `assert.*`, `t.is`, snapshot matchers, or `await expect(...).rejects`.
- Edge: a test that only asserts inside a callback that may never run is `yes`.
- Edge: a skipped or todo test is `no` (it does not run).

### `oracle/weak-matcher`

**Problem:** the test only proves a value exists, not what it is.

- `yes`: `toBeTruthy`, `toBeDefined`, `not.toBeNull`, `toBeInstanceOf(Object)`, `expect.anything()`, and similar, used as the **only** check on a value whose contents matter.
- `no`: the same matcher when existence or truthiness is the real behaviour (a boolean flag, a found/not-found result), or when stronger assertions on the same value follow in the same test.
- Edge: `toHaveBeenCalled` is a different rule (`interaction-only`).

### `oracle/interaction-only`

**Problem:** every assertion checks that something was called; none checks a result or visible effect.

- `yes`: the test's only assertions are `toHaveBeenCalled*` or mock call counts, and a returned value or observable state exists to check.
- `no`: the call itself is the behaviour (a callback contract, an event emitter, a fire-and-forget notifier with no result), or the test also checks a result.
- Edge: asserting call **arguments** is stronger than asserting a call happened, but it is still interaction-only if nothing checks the outcome. Label `yes`, and say so in the reason.

### `oracle/tautological-assertion`

**Problem:** the assertion cannot fail.

- `yes`: `expect(x).toBe(x)`, `expect(1).toBe(1)`, `expect(true).toBe(true)`, `expect('a').toEqual('a')`, a literal compared with a literal.
- `no`: both sides come from different computations that happen to be equal, or the comparison is deliberately an identity check (`expect(cache.get(k)).toBe(cache.get(k))` to prove caching).
- Edge: a variable assigned a literal one line earlier and then compared with it is `yes`.

### `oracle/swallowed-async`

**Problem:** an async assertion is not awaited or returned, so its failure cannot fail the test.

- `yes`: `expect(promise).resolves...` or `.rejects...` without `await` or `return`, or an assertion inside a `.then`/callback the test does not wait for.
- `no`: awaited, returned, or passed to a helper that awaits it. A synchronous callback that runs before the test ends is `no`.
- Edge: `findBy*` or `waitFor` without `await` is `yes`.

### `oracle/mocks-subject`

**Problem:** the test replaces the very module it claims to test.

- `yes`: a file named `foo.test.ts` mocks `./foo` (or the module the test is clearly about), then asserts on the mock.
- `no`: it mocks a **dependency** of the subject, or mocks a sibling module while testing `foo`.
- Edge: partial mocks (`vi.mock('./foo', async (orig) => ({ ...(await orig()), bar: vi.fn() }))`) are `yes` only if the mocked part is what the test asserts about.

### `oracle/tautological-mock`

**Problem:** the test sets a mock to return a value and then asserts that value came back, so the code under test is not involved.

- `yes`: `fn.mockReturnValue(5); expect(fn()).toBe(5)`, or the same through a wrapper that adds nothing.
- `no`: the mocked function is a dependency and the code under test transforms or routes its value (`dep.mockReturnValue(5); expect(sut()).toBe(10)`).
- Edge: when the code under test merely forwards the value unchanged, label `yes`, because deleting the forwarding logic would not fail the test... unless forwarding **is** the behaviour (a thin wrapper test). Use `unsure` and say so.

## Integrity rules (cases with a previous version)

These rules compare **before and after**. Label from the diff.

### `integrity/test-removed`

**Problem:** a test that existed is gone and its behaviour is not covered elsewhere.

- `yes`: the test is deleted outright, or its body was emptied.
- `no`: the test was renamed, moved, merged into a table-driven test that still covers its cases, or covered by an equivalent new test in the same change.

### `integrity/assertions-dropped`

**Problem:** a surviving test lost assertions.

- `yes`: assertions were deleted and nothing replaced them.
- `no`: assertions were replaced by equal or stronger ones, or merged into one more specific check, or the removed assertions were redundant duplicates.

### `integrity/matcher-weakened`

**Problem:** an assertion was changed to a weaker matcher.

- `yes`: `toEqual({...})` → `toBeTruthy()`; `toBe(3)` → `toBeDefined()`; a specific value → a type check.
- `no`: the matcher changed because the **behaviour** changed and the new assertion is equally specific, or it moved from one equally strong form to another (`toBe` → `toStrictEqual`).
- Edge: a loosened matcher accompanied by a plain-English reason in the diff or commit message is still `yes`; the rule's job is to surface it.

### `integrity/modifier-added`

**Problem:** a test was disabled or isolated.

- `yes`: new `.skip`, `.todo`, `.only`, `xit`, `xdescribe`, `fixme`, `test.fail`, or a conditional skip with no reason.
- `no`: a skip that carries a clear, narrow reason tied to an environment (`skipIf(process.platform === 'win32')`) is still `yes` for the rule, but mark the reason `environment-conditional`, because the adjudicators will want to see it.

## Edge cases that apply to every rule

- **Generated or vendored test files** (snapshots, fixtures, codegen output): label `unsure` with the reason `generated`, and the file is dropped from precision counts.
- **Tests you cannot understand without seeing other files:** label `unsure`. Do not guess.
- **A test that is wrong in a way no rule covers:** write it in the file `note`. Do not invent a rule.
- **Never look at crashdummy's output** until you have finished a case.

## Label file format

One JSON file per labeller, `labels.<labeller>.json`:

```json
{
  "labeller": "human",
  "schema": 1,
  "cases": {
    "<case id>": {
      "file": "good",
      "note": "optional free text",
      "tests": {
        "<test id>": {
          "oracle/weak-matcher": { "label": "yes", "reason": "only checks the user exists" },
          "oracle/no-assertion": { "label": "no" }
        }
      }
    }
  }
}
```

- `labeller`: `human`, `claude-opus`, `claude-sonnet`, `claude-haiku`.
- `test id`: the id printed in the case page (stable across runs; derived from the test's full name and position).
- A rule you did not label for a test is treated as **not labelled**, not as `no`.
- `file`: `good` | `weak`.

The reconciled result lives in `corpus/labels.json` with one extra block per test and rule:

```json
{ "human": "yes", "claude": { "opus": "yes", "sonnet": "yes", "haiku": "no" }, "final": "yes", "source": "human" }
```

`final` is decided by this order:

1. If the human labelled `yes` or `no`, that is final (`source: "human"`).
2. If the human said `unsure`, the majority of the three model labels decides (`source: "models"`). A tie stays `unsure` and is excluded from precision.
3. If the human did not label it, and the models are unanimous, that is final (`source: "models-unanimous"`). Otherwise it is excluded.

Disagreements between the human and a majority of models are listed in `corpus/adjudication.md` for a second look.
