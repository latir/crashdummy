import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

/**
 * A test that runs code but checks nothing passes whatever the code does. Assertions inside local
 * helpers the test calls count, one level deep. A helper imported from another file cannot be
 * followed: it counts when it is named `expectX` or `assertX`, and otherwise its name has to be
 * listed in `assertFunctionNames`.
 */
export const noAssertion: OracleRule = {
  id: 'oracle/no-assertion',
  layer: 'oracle',
  meta: {
    evidence: 'strong',
    summary: 'A test has no assertion, so it cannot fail when the code is wrong.',
    penalty: 15,
    cap: 30,
    gate: true,
    severity: 'error',
  },
  create(ctx) {
    return {
      finish: () =>
        ctx
          .facts()
          .filter((t) => !isDisabled(t.modifier) && t.assertions.length === 0)
          .map((t) =>
            oracleFinding(noAssertion, ctx.file, {
              test: t.id,
              loc: t.loc,
              message: `test '${t.id}' has no assertion`,
              hint: 'Assert on the result. If a helper imported from another file asserts, name it `expectX` / `assertX` or add its name to `assertFunctionNames`.',
            }),
          ),
    };
  },
};
