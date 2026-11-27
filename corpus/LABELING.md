# Labeling guide

How to decide whether a crashdummy rule is **right** about a test. Read this before labelling, whether you are a person or a model. Everyone uses the same definitions.

## Quick start (two minutes)

1. Open a case. Read the file header: repo, file name, what the framework is, how many tests.
2. For each test, ask one question: **if the code under test had a plausible bug, would this test fail?**
3. If yes, tick nothing and press **Reviewed**. Most tests are fine.
4. If no, find which rule below describes _why_ it would not fail, and tick that rule. A test can have more than one problem.
5. If you cannot tell from the code shown, tick the rule twice (unsure) and say why in one line.

You do not need to be exhaustive about every rule on every test. Scan the test for the cues listed under each rule, tick what you see, and move on. A reviewed test with nothing ticked means "none of these problems".

## What you are labelling

Each corpus case is one test file written or changed by an AI coding agent. Cases that have a previous version also carry the diff.

You label **per test, per rule**. For every test in the case and every rule below, the question is:

> Does this test have this problem?

Answer from the test code alone. You do not see what crashdummy reported. Findings are hidden on purpose so they cannot bias you.

| Answer   | Meaning                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `yes`    | The test has the problem the rule describes.                               |
| `no`     | The test does not have it.                                                 |
| `unsure` | You cannot tell from the code shown. Use sparingly; say why in the reason. |

Also give each **file** a quality of `good` or `weak`: would you trust this file to catch a regression? This is a sanity check on the whole score, not tied to one rule.

Add a one-line `reason` for every `yes` and every `unsure`. A reason makes adjudication fast.

## Where to look

Each test card gives you more than the test itself:

- **The test source**, with line numbers from the file.
- **Helpers it calls**, defined in the same file. A test that calls `expectReady()` may assert inside it. Read the helper before deciding.
- **Imports it uses**, with where each comes from. A helper imported from another file is not shown; judge it by its name and how the test uses it, and say `unsure` if the whole test hangs on it.
- **Whole file** tab: imports, shared setup (`beforeEach`), and constants.
- **Change** tab (cases with a previous version): the diff. Needed for the integrity rules.

## Principles

1. **Ask what would happen if the code were wrong.** A test is healthy when a plausible bug in the code under test makes it fail. Every rule below is a way that cannot happen.
2. **Judge the behaviour, not the style.** `toBeTruthy()` on a boolean the code returns is fine. The same matcher on an object that could be any object is not.
3. **Context beats syntax.** Read the surrounding test before you decide. A helper called `expectValid(x)` may assert inside.
4. **Do not reward volume.** More `expect` calls never make a test better. Count nothing.
5. **When the intent is clearly smoke or snapshot-style by design, say `no`.** A test named "renders without crashing" that only renders is honest about its scope. The rule is about tests that claim more than they check.
6. **A guard is not the check.** `expect(job).not.toBeNull()` followed by `expect(job.id).toBe(1)` is a normal pattern. Only the guard alone is a problem.

## Rule definitions

Each rule has the problem in plain words, what to look for, and examples of both answers.

### `oracle/no-assertion`

**Problem:** the test cannot fail because it checks nothing.

**Look for:** a test body with no `expect`, `assert`, `t.assert`, `expectTypeOf`, snapshot or similar, and no helper that asserts.

- `yes`: the body calls code and never asserts, expects, or verifies. Awaiting a promise that could reject counts as a check only if the test is documented as "does not throw".
- `no`: an assertion is reached, including through a helper that asserts, `expect.assertions`, `assert.*`, `t.is`, snapshot matchers, `expectTypeOf`, or `await expect(...).rejects`.
- Edge: a test that only asserts inside a callback that may never run is `yes`.
- Edge: a skipped or todo test is `no` (it does not run).
- Edge: a smoke test titled "does not throw" or "is safe" that awaits the call is a judgement call. Say `yes` if nothing in the title or code says not throwing is the point, `no` if it does.

```ts
// yes: nothing is checked
test('adds item', () => {
  cart.add(item);
});

// no: the helper asserts (read it in "Helpers it calls")
test('adds item', () => {
  cart.add(item);
  expectTotal(cart, 30);
});
```

### `oracle/weak-matcher`

**Problem:** the test only proves a value exists, not what it is.

**Look for:** `toBeTruthy`, `toBeDefined`, `not.toBeNull`, `toBeInstanceOf(Object)`, `expect.anything()`, `assert.ok(x)` with `x` a bare variable.

- `yes`: those matchers are the **only** checks in the test, on a value whose contents matter.
- `no`: another assertion in the test checks a real value (the existence check is a guard), or the value is already a yes or no (`assert.ok(list.includes(x))`, `assert(result.success)`), or existence is the real behaviour (a found/not-found result).
- Edge: `toHaveBeenCalled` is a different rule (`interaction-only`).

```ts
// yes: any object passes
const user = await find(1);
expect(user).not.toBeNull();

// no: the guard is followed by a real check
expect(job).not.toBeNull();
expect(job!.id).toBe(1);

// no: already a yes or no
assert.ok(paths.includes('/match/1'));
```

### `oracle/interaction-only`

**Problem:** every assertion checks that something was called; none checks a result or visible effect.

**Look for:** a test whose assertions are all `toHaveBeenCalled*` or call counts, where the code under test also returns a value or changes visible state that nobody checks.

- `yes`: the test's only assertions are `toHaveBeenCalled*` or mock call counts, and a returned value or observable state exists to check.
- `no`: the call itself is the behaviour (a callback contract, an event emitter, a fire-and-forget notifier with no result), the assertion is that nothing was called (`not.toHaveBeenCalled`), or the test also checks a result.
- Edge: asserting call **arguments** (`toHaveBeenCalledWith(...)`) is `no`. What the code hands to a logger, a sender or an exit function is its output. Only "was it called" and "how many times" are interaction-only.

```ts
// yes: the result is captured and ignored
const total = cart.checkout();
expect(payments.charge).toHaveBeenCalled();

// no: nothing returns; the call is the effect
notifier.send(message);
expect(transport.deliver).toHaveBeenCalledWith(message);
```

### `oracle/tautological-assertion`

**Problem:** the assertion cannot fail.

**Look for:** the same expression on both sides, or a literal compared with a literal.

- `yes`: `expect(x).toBe(x)`, `expect(1).toBe(1)`, `expect(true).toBe(true)`, `expect('a').toEqual('a')`, a literal compared with a literal.
- `no`: both sides come from different computations that happen to be equal, or the comparison is deliberately an identity check (`expect(cache.get(k)).toBe(cache.get(k))` to prove caching).
- Edge: a variable assigned a literal one line earlier and then compared with it is `yes`.

```ts
// yes
const name = 'a';
expect(name).toBe('a');

// no: proves the cache returns the same object
expect(cache.get('k')).toBe(cache.get('k'));
```

### `oracle/swallowed-async`

**Problem:** an async assertion is not awaited or returned, so its failure cannot fail the test.

**Look for:** `expect(...).resolves` / `.rejects` with no `await` or `return` in front; `findBy*` / `waitFor` with no `await`; assertions inside a `.then(...)` the test does not wait for.

- `yes`: not awaited, not returned, not passed to a helper that awaits it.
- `no`: awaited, returned, or passed to a helper that awaits it. A synchronous callback that runs before the test ends is `no`.

```ts
// yes
test('loads', () => {
  expect(load()).resolves.toBe(1);
});

// no
test('loads', async () => {
  await expect(load()).resolves.toBe(1);
});
```

### `oracle/mocks-subject`

**Problem:** the test replaces the very module it claims to test.

**Look for:** `vi.mock('./foo')` or `jest.mock('./foo')` in `foo.test.ts`, or a mock of the module named in the test title.

- `yes`: a file named `foo.test.ts` mocks `./foo` (or the module the test is clearly about), then asserts on the mock.
- `no`: it mocks a **dependency** of the subject, or mocks a sibling module while testing `foo`.
- Edge: partial mocks (`vi.mock('./foo', async (orig) => ({ ...(await orig()), bar: vi.fn() }))`) are `yes` only if the mocked part is what the test asserts about.

### `oracle/tautological-mock`

**Problem:** the test sets a mock to return a value and then asserts that value came back, so the code under test is not involved.

**Look for:** `mockReturnValue(x)` / `mockResolvedValue(x)` followed directly by an assertion that `x` is returned.

- `yes`: `fn.mockReturnValue(5); expect(fn()).toBe(5)`, or the same through a wrapper that adds nothing.
- `no`: the mocked function is a dependency and the code under test transforms or routes its value (`dep.mockReturnValue(5); expect(sut()).toBe(10)`).
- Edge: when the code under test merely forwards the value unchanged, label `yes`, unless forwarding **is** the behaviour (a thin wrapper test). Use `unsure` and say so.

## Integrity rules (cases with a previous version)

These rules compare **before and after**. Open the **Change** tab and label from the diff. They apply to the new version's tests, and to tests that were removed.

### `integrity/test-removed`

**Problem:** a test that existed is gone and its behaviour is not covered elsewhere.

**Look for:** a deleted `it`/`test` block in the diff with no equivalent added.

- `yes`: the test is deleted outright, or its body was emptied.
- `no`: the test was renamed, moved, merged into a table-driven test that still covers its cases, or covered by an equivalent new test in the same change.

### `integrity/assertions-dropped`

**Problem:** a surviving test lost assertions.

**Look for:** `-` lines with `expect`/`assert` inside a test that still exists, and no `+` lines replacing them.

- `yes`: assertions were deleted and nothing replaced them.
- `no`: assertions were replaced by equal or stronger ones, or merged into one more specific check, or the removed assertions were redundant duplicates.

### `integrity/matcher-weakened`

**Problem:** an assertion was changed to a weaker matcher.

**Look for:** a `-` line and a `+` line on the same assertion where the matcher got looser.

- `yes`: `toEqual({...})` → `toBeTruthy()`; `toBe(3)` → `toBeDefined()`; a specific value → a type check.
- `no`: the matcher changed because the **behaviour** changed and the new assertion is equally specific, or it moved from one equally strong form to another (`toBe` → `toStrictEqual`).
- Edge: a loosened matcher accompanied by a plain-English reason in the diff is still `yes`; the rule's job is to surface it.

### `integrity/modifier-added`

**Problem:** a test was disabled or isolated.

**Look for:** a `+` line adding `.skip`, `.todo`, `.only`, `xit`, `xdescribe`, `fixme`, or `test.fail`, on a test that ran before.

- `yes`: new `.skip`, `.todo`, `.only`, `xit`, `xdescribe`, `fixme`, `test.fail`, or a conditional skip with no reason.
- Edge: an environment-conditional skip (`skipIf(process.platform === 'win32')`) is still `yes` for the rule, because it newly turns the test off. Say `environment-conditional` in the reason so the adjudicators can see it.
- A modifier that was already in the previous version is `no`.

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
- A rule you did not label for a test is treated as **not labelled**, not as `no`. In the hosted page, a test you mark Reviewed counts as `no` for every rule you did not tick.
- `file`: `good` | `weak`.

The reconciled result lives in `corpus/labels.json` with one extra block per test and rule:

```json
{
  "human": "yes",
  "claude": { "opus": "yes", "sonnet": "yes", "haiku": "no" },
  "final": "yes",
  "source": "human"
}
```

`final` is decided by this order:

1. If the human labelled `yes` or `no`, that is final (`source: "human"`).
2. If the human said `unsure`, the majority of the three model labels decides (`source: "models"`). A tie stays `unsure` and is excluded from precision.
3. If the human did not label it, and the models are unanimous, that is final (`source: "models-unanimous"`). Otherwise it is excluded.

Disagreements between the human and a majority of models are listed in `corpus/adjudication.md` for a second look.
