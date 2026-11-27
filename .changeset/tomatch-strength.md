---
'crashdummy': patch
---

`integrity/matcher-weakened` no longer reports `toContain` becoming `toMatch`. Both check that a string contains something, so `toMatch` now has the same strength as `toContain`.
