# fixtures

Per-rule `valid/` and `invalid/` test files, plus `before`/`after` pairs for integrity rules. An `invalid` fixture marks expected findings with `// expect: <ruleId>`. These files are data: they are never run by Vitest.

`fixtures/parse/` holds sample test files for the `TestSummary` builder (nested describes, `.each`, async tests, assertion helpers, modifiers, mocks, Playwright and `node:test`). They are read by `packages/core/test/parse/`.
