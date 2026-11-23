# crashdummy

**Crashes your code on purpose and checks whether your tests notice.**

crashdummy is a fast, deterministic CLI that scores the quality of new and changed JS/TS tests out of 100, and fails changes that weaken a test suite. It is aimed at AI-written tests, but scores any test the same way.

> **Status: coming soon.** This package is a placeholder while the first release is built. Nothing is usable yet.

## Why

AI agents write tests that pass but prove little: they assert on the mock they just set up, check only that something is defined, or get to green by removing, skipping or loosening tests. Coverage can't see this. crashdummy can.

- **A score out of 100 per test file**, with the reason behind every point lost. No letter grades.
- **Integrity gates** that fail a change regardless of score: removed tests, new `.skip` / `.only`, loosened matchers, raised timeouts, new suppressions.
- **A per-file baseline** so suite quality can be tracked and ratcheted over time.
- **Compact output for coding agents**, so weak tests get fixed before a human reviews them.

## Name

A crash test dummy is crashed on purpose to see whether the safety systems work. crashdummy does the same to your code (mutation testing, in later tiers) and checks whether your tests notice.

## Principles

- **Fast by default.** The static tier targets under 300 ms for a typical change, so it can run after every agent edit.
- **Deterministic.** No LLM calls. Every result is reproducible from the code alone.
- **Agnostic.** The core knows nothing about git, CI or any agent harness. Adapters plug those in.
- **Explainable.** Every lost point maps to a finding with a file, line and fix hint.

## Roadmap

| Milestone | What ships                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | Tier 0: static analysis and integrity gates for Vitest and Jest, `git` and `files` change sources, `pretty` / `agent` / `json` output |
| M2–M5     | Baselines and ratcheting, agent hooks and adapters, coverage (tier 1), mutation testing (tier 2)                                      |

See the full design in [docs/technical-plan.md](docs/technical-plan.md).

## License

[MIT](LICENSE)
