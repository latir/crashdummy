---
'crashdummy': minor
---

A function named `expectX` or `assertX` that is imported from another file now counts as an assertion without configuration, because its body cannot be read. Any other helper name still goes in `assertFunctionNames`. A helper written in the same file is still followed, so one called `expectOk` that asserts nothing does not count. Cached summaries are rebuilt.
