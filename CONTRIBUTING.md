# Contributing to crashdummy

Thanks for helping. Read [docs/technical-plan.md](docs/technical-plan.md) first: it is the source of truth for the architecture, the rules and the scoring. [CLAUDE.md](CLAUDE.md) lists the decisions that are settled. Please open an issue before proposing changes to them.

## Setup

You need Node 22 or newer for development (the published CLI supports Node 20.19+) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
pnpm test
```

Before opening a PR, run everything CI runs:

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm check:deps
```

## Conventions

- **TypeScript, ESM only**, strict mode. No dependency on the TypeScript compiler or ESLint: parsing uses `oxc-parser`.
- **No new production dependencies** without discussion. The budget is 5, and CI enforces it.
- **The core stays agnostic.** `@crashdummy/core` knows nothing about git, CI or any agent harness. Sources and adapters plug in.
- **Deterministic.** No LLM calls, no network, no clock or randomness in results.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org) (`feat(core): ...`, `fix: ...`, `docs: ...`).
- **Changesets.** A change users can see needs one: run `pnpm changeset`. The CLI (`crashdummy`) bundles `@crashdummy/core`, so a change to core needs a `crashdummy` changeset when it changes what the CLI does for users. Otherwise name the package you changed.
- **Never reward assertion count.** Penalize weak or tautological assertions only.

## Tests

Every rule has fixtures next to it, in `valid/` and `invalid/` folders. An `invalid` fixture marks each expected finding with a comment, like `// expect: oracle/no-assertion`. Integrity rules use `before` / `after` pairs, including tricky renames and reordered tests. Fixtures are data: Vitest never runs them.

False positives matter more than missed findings. A rule that is wrong more than about 1 time in 20 on real tests should not be on by default.

## Add a matcher to the lattice

Most contributions are likely to be matchers that crashdummy does not recognise yet. Edit `packages/core/src/rules/lattice.json`:

1. **Find the chain.** Chains are ordered lists, strongest first. If your matcher is a weaker or stronger version of an existing one (`toBeInstanceOf` next to `toMatch`), put it in that chain at the right level. If it stands alone, add a new chain with one level.
2. **Pick the strength:** 4 = exact value, 3 = structural or partial value, 2 = range, type or interaction, 1 = existence only. Be conservative. A wrong high strength hides weakening, a wrong low strength can flag healthy tests.
3. **Use `name@arg` for argument-sensitive matchers** (`toThrow@none` versus `toThrow@other`). The argument kinds are `literal`, `other` and `none`.
4. **Add aliases** under `aliases` instead of repeating entries. A negated alias looks like `{ "name": "assert.equal", "negated": true }`.
5. **Add rows to `packages/core/test/lattice.test.ts`.** At least one comparison with a neighbouring matcher and one `strength` row. A matcher may appear only once in the file; loading fails otherwise.
6. Run `pnpm test`, and add a changeset.

If you only need a matcher for your own project, you do not have to change crashdummy: use the `matchers` config key ([docs/matchers.md](docs/matchers.md#your-own-matchers)).

If you are not sure where a matcher belongs, open a ["matcher not recognised" issue](../../issues/new?template=unrecognised-matcher.yml) and we will place it together.

## Add a rule

A rule is one file in `packages/core/src/rules/` exporting `{ id, layer, meta, create(ctx) }`. Rules are visitors on the shared AST walk: do not parse again, and do not touch the engine. Include `meta` with the evidence rating and a source, because the rule's docs page cites it. Add `valid/` and `invalid/` fixtures as described above.

## Pull requests

- One logical change per PR, with tests.
- Say what you changed and why, and note anything you were unsure about.
- CI must be green.

## Integrity fixtures

Integrity rules compare two versions of a file, so their fixtures are pairs in `fixtures/integrity/<rule>/{valid,invalid}/`: `<case>.before.test.ts` and `<case>.after.test.ts`. An `// expect: <ruleId>` comment marks a finding on the next line (or on its own line when it trails code). Markers in the `before` file are for findings located in the old file (`integrity/test-removed`). A `valid` pair must produce no findings at all. See [docs/integrity.md](docs/integrity.md).
