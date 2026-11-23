# crashdummy

Open source npm CLI that scores the quality of new/changed JS/TS tests out of 100 (focused on AI-written tests) and fails changes that weaken a suite: removed tests, new skips/`.only`, loosened matchers, raised timeouts, new suppressions. Name story: it crashes your code on purpose (mutation testing) and checks whether your tests notice.

**Source of truth: `docs/technical-plan.md`.** Read it fully before starting any issue. It defines architecture, data model, rules, scoring and milestones. If it is ambiguous, ask rather than guess.

## Decisions (do not relitigate without asking)

- TypeScript (strict), Node 20+, ESM only, pnpm workspace, tsdown bundling, Vitest, Changesets.
- Parse with `oxc-parser` only. No TypeScript compiler, no type info, no ESLint dependency. Keep one internal AST adapter layer that rules use.
- `@crashdummy/core` is agnostic: no git/CI/agent knowledge in the engine. Change sources and adapters plug in. The engine only sees `ChangedFile[]`.
- Deterministic. No LLM calls. Model- and harness-agnostic.
- Performance: tier 0 under 300 ms for 10 files including Node startup. At most 5 production dependencies (audited in CI). Lazy-load tier 1/2, SARIF, MCP. No dynamic `import()` on the hot path.
- Scores are integers out of 100. No letter grades.
- Integrity rules are pass/fail gates outside the score.
- Rule weights follow the evidence ratings in the plan. Never reward assertion count. The `agent` format never prints rule weights.
- Unknown stays unknown: stale coverage or mutation timeouts are never a pass or a 0.
- No git library: shell out to the `git` binary.
- Config is plain JSON (`.crashdummy/config.json` or `"crashdummy"` in `package.json`), never a TS config.

## Layout

pnpm workspace: `packages/core` (`@crashdummy/core`), `packages/cli` (`crashdummy`, bundled to one file), later `mcp`, `action`, `danger`. Also `fixtures/`, `corpus/`, `bench/`. Core internals: `sources/`, `parse/`, `rules/`, `tiers/`, `score/`, `baseline/`, `report/`.

Each rule is one file exporting `{ id, layer, meta, create(ctx) }`; rules are visitors on one shared AST walk. Adding a rule must not touch the engine. Matcher strength lives in data (`rules/lattice.json`).

## Workflow

- Work is tracked in Linear: project "crashdummy", workspace calluna-app, team "crashdummy" (key CD). M1 = CD-5 to CD-14 (CD-12 reserve name, CD-11 parser, CD-10 sources, CD-13 lattice, CD-9 integrity gates, CD-8 oracle rules, CD-7 scorer/reporters, CD-6 corpus, CD-5 bench, CD-14 scaffold); M2-M5 parents = CD-4, CD-3, CD-2, CD-1. Issues moved from the CAL team, so old CAL-xx ids are obsolete.
- Respect "blocked by" relations. Each issue's "Done when" checklist is the acceptance criteria.
- One branch + one PR per issue, using the issue's Linear git branch name (e.g. `latircole/cd-14-...`). Conventional commits.
- Before starting an issue, move it to In Progress. Link the PR to it. When the PR is merged, mark it Done.
- Show a short plan before large changes.
- Fixture-based tests for every rule: `valid/` and `invalid/` files, with `// expect: <ruleId>` comments marking expected findings; before/after pairs for integrity rules.
- Do not create PRs, publish to npm, or transfer GitHub orgs beyond what the issue asks. npm: `crashdummy` is reserved (user is maintainer); npm org `crashdummy` exists; GitHub org `crashdummyjs` is reserved for a later transfer. Publishing needs the user's approval.
