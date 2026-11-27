---
'crashdummy': patch
---

Fewer false alarms from the oracle rules. `oracle/no-assertion` now counts `expect` taken from the test context (`({ expect }) => ...`) and `expectTypeOf(...)`. `oracle/weak-matcher` reports a test only when none of its assertions checks a value, and ignores truthiness checks on yes/no values and `toHaveBeenCalledWith(expect.anything(), ...)` with other arguments pinned. `oracle/interaction-only` ignores `not.toHaveBeenCalled()`.
