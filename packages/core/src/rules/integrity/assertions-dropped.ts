import type { IntegrityRule } from './types.js';
import { gateFinding } from './finding.js';
import { isDisabling } from './modifier-added.js';

/**
 * A test that still exists checks fewer things than before. The count is only ever used to detect
 * a drop; adding assertions is never rewarded.
 *
 * A test that was just skipped or turned into a todo is reported by `modifier-added`, so it is not
 * reported twice.
 */
export const assertionsDropped: IntegrityRule = {
  id: 'integrity/assertions-dropped',
  layer: 'integrity',
  side: 'after',
  meta: {
    evidence: 'strong',
    summary: 'A test that still exists has fewer assertions than before.',
  },
  check(ctx) {
    const findings = [];
    for (const { before, after } of ctx.pairs) {
      if (isDisabling(after)) continue;
      const was = before.matchers.length;
      const now = after.matchers.length;
      if (now >= was) continue;
      findings.push(
        gateFinding(this.id, ctx.file, {
          loc: after.loc,
          message: `test '${after.id}' has ${now} assertion${now === 1 ? '' : 's'}, it had ${was}`,
          hint: 'Restore the removed assertions. If dropping them is intended, add `// crashdummy-allow integrity/assertions-dropped: <reason>` above the test.',
        }),
      );
    }
    return findings;
  },
};
