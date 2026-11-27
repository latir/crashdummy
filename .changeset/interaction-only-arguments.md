---
'crashdummy': patch
---

`oracle/interaction-only` no longer reports tests that pin the arguments of a call (`toHaveBeenCalledWith`, `toHaveBeenCalledExactlyOnceWith` and the like). What the code hands to a logger, a sender or an exit function is its output. The rule now covers only "was it called" and "how many times".
