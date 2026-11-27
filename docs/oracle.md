# Oracle rules

Oracle rules ask one question of a single test file: does each test check what the code does? They run on the same parse as the summary builder, so adding them costs no extra pass. Each finding has a one-line message, a fix hint and an evidence rating. The score takes `penalty` per finding, up to `cap` per rule per file. A **gate** also fails the check, because a test like that checks nothing at all.

| Rule                            | Fires when                                                                                                                           | Evidence | Penalty / cap | Gate    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------- | ------- |
| `oracle/no-assertion`           | A test has no assertion, after following local helpers one level deep.                                                               | strong   | 15 / 30       | yes     |
| `oracle/tautological-assertion` | The checked value is a literal, or a plain reference is compared with itself (`expect(x).toBe(x)`).                                  | strong   | 15 / 30       | yes     |
| `oracle/swallowed-async`        | An `.resolves` / `.rejects` assertion is not awaited or returned, `expect` runs in a dropped `.then`, or an async test takes `done`. | strong   | 10 / 20       | yes     |
| `oracle/mocks-subject`          | `vi.mock` / `jest.mock` replaces the module the test file is named after (`cart.test.ts` and `./cart`).                              | moderate | 15 / 30       | not yet |
| `oracle/tautological-mock`      | A mock is set to return X and the test asserts that its own result is X.                                                             | moderate | 12 / 24       | no      |
| `oracle/weak-matcher`           | A value is only checked for existing (`toBeTruthy`, `toBeDefined`, `not.toBeNull`), with no stronger assertion on it.                | moderate | 5 / 15        | no      |
| `oracle/interaction-only`       | Every assertion is `toHaveBeenCalled*`, and the test captured a result it never checks.                                              | moderate | 6 / 18        | no      |

## Warnings until measured

`oracle/weak-matcher` and `oracle/mocks-subject` stay at warning severity until precision is measured on the corpus. `mocks-subject` becomes a gate for full mocks only. A partial mock, where the factory spreads the real module (`importOriginal`, `requireActual`), only warns and takes no penalty.

## Custom assertion helpers

A helper imported from another file cannot be followed, so crashdummy goes by its name. A function called `expectX` or `assertX` (an upper-case letter or `_` after the prefix, so `expectNoViolations` and `assertValid_`, not `expected` or `assertion`) counts as an assertion without any configuration, and so does a method such as `helpers.expectOk()`. What it checks is up to the helper, so it counts as an assertion but never as a strong one.

Any other name has to be listed in `assertFunctionNames` (`*` is a wildcard, matched against the dotted call path):

```json
{ "assertFunctionNames": ["verifyReady", "check*", "helpers.verify*"] }
```

Helpers in the same file are followed one level deep without any configuration, whatever they are called. That includes one named `expectOk`: if its body asserts nothing, calling it is not an assertion. The name is only trusted when the code cannot be read.

## What counts as an assertion

Besides `expect(...)`, `assert.*` and `t.assert.*`:

- `expect` taken from the test context, as in vitest's `it('x', ({ expect }) => { ... })`.
- `expectTypeOf(...)` type assertions (`toEqualTypeOf`, `toMatchTypeOf` and the rest).

## What `oracle/weak-matcher` leaves alone

It reports a test only when none of its assertions checks what a value is. One real check anywhere in the test, such as `toBe(3)`, makes the existence checks guards, so it stays quiet. It also stays quiet for a truthiness check on a value that is already a yes or no (`assert.ok(list.includes(x))`, `assert(result.success)`), and for `toHaveBeenCalledWith(expect.anything(), 'a', 'b')`, where the other arguments are pinned.

## What `oracle/interaction-only` leaves alone

A test that asserts `not.toHaveBeenCalled()` is checking that nothing was sent. That is the behaviour, so it is not reported.

## What it does not do

- Tests marked `skip`, `todo` or `fixme` are not judged. Turning a test off is the integrity layer's concern.
- When the module under test cannot be told (no import matches the test file's name), `mocks-subject` stays quiet. Unknown stays unknown.
- Adding assertions is never rewarded. No rule counts assertions.
