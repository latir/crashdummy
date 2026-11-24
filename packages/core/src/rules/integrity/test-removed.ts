import type { IntegrityRule } from './types.js';
import { gateFinding, listIds } from './finding.js';

/**
 * A test that was in the old file is gone, was not renamed or moved, and the code it tested is
 * still there. Deleting the code and its tests together is a refactor; deleting only the tests is
 * the way an agent makes a failing suite pass.
 *
 * A `todo` placeholder has no body to lose, so removing one is not a removal.
 */
export const testRemoved: IntegrityRule = {
  id: 'integrity/test-removed',
  layer: 'integrity',
  side: 'before',
  meta: {
    evidence: 'strong',
    summary: 'A test was removed (not renamed or moved) while the code it tested still exists.',
  },
  check(ctx) {
    const removed = ctx.removed.filter((t) => t.modifier !== 'todo');
    if (removed.length === 0 || !ctx.sourceStillExists()) return [];
    return removed.map((t) =>
      gateFinding(this.id, ctx.file, {
        loc: t.loc,
        message: `test ${listIds([t.id])} was removed`,
        hint: 'Restore it. If it moved, keep its body unchanged. If removing it is intended, add `// crashdummy-allow integrity/test-removed: <reason>` at the top of the file.',
      }),
    );
  },
};
