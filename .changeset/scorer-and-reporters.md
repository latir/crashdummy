---
'crashdummy': minor
---

`crashdummy` now checks your tests. It scores each changed test file out of 100, fails changes that weaken a suite, and prints the result as `pretty`, `agent` or `json`. Exit codes are stable: 0 pass, 1 fail, 2 warn (with `--strict-warn`), 3 tool error. `crashdummy explain <rule>` shows what a rule catches and how to fix it. Config goes in `.crashdummy/config.json`.
