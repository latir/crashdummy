---
'crashdummy': patch
---

Integrity findings now say which test they are about. `integrity/test-removed`, `assertions-dropped` and `matcher-weakened` set `test` on each finding, and `modifier-added` sets `test`, or `tests` when it groups several tests that were turned off together. The `json` format carries the new fields.
