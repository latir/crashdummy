import { child, str, unwrap, type AstNode } from '../../parse/ast.js';
import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

/** Matchers that ask only whether a value is truthy. */
const TRUTHY = new Set(['toBeTruthy', 'assert.ok']);
const COMPARISONS = new Set(['==', '===', '!=', '!==', '<', '<=', '>', '>=', 'instanceof', 'in']);
/** Calls that answer yes or no: `list.includes(x)`, `Array.isArray(x)`, `res.ok()`, `isReady()`. */
const BOOLEAN_CALL =
  /^(includes|some|every|startsWith|endsWith|test|has|hasOwn|hasOwnProperty|isArray|isInteger|isFinite|isNaN|isSafeInteger|ok|equals|matches|contains)$|^(is|has|can|should|was)[A-Z]/;
/** Properties that hold a yes or no: `result.success`, `res.ok`, `item.isActive`. */
const BOOLEAN_PROP =
  /^(ok|success|succeeded|passed|valid|enabled|disabled|done|exists|connected|visible|hidden|checked|selected|empty)$|^(is|has|can|should|was)[A-Z]/;

/**
 * The value is a yes or no, so asking whether it is truthy is the whole check:
 * `assert.ok(list.includes(x))`, `assert(result.success)`, `expect(a > b).toBeTruthy()`.
 */
export function isBooleanValued(node: AstNode | undefined): boolean {
  if (!node) return false;
  const n = unwrap(node);
  switch (n.type) {
    case 'BinaryExpression':
      return COMPARISONS.has(str(n, 'operator') ?? '');
    case 'UnaryExpression':
      return str(n, 'operator') === '!';
    case 'LogicalExpression': {
      const op = str(n, 'operator');
      const left = isBooleanValued(child(n, 'left'));
      const right = isBooleanValued(child(n, 'right'));
      if (op === '&&') return right;
      return op === '||' && left && right;
    }
    case 'CallExpression': {
      const callee = child(n, 'callee');
      const c = callee ? unwrap(callee) : undefined;
      if (!c) return false;
      const prop = c.type === 'MemberExpression' ? child(c, 'property') : c;
      return BOOLEAN_CALL.test((prop && str(prop, 'name')) ?? '');
    }
    case 'MemberExpression': {
      if (n['computed'] === true) return false;
      const prop = child(n, 'property');
      return BOOLEAN_PROP.test((prop && str(prop, 'name')) ?? '');
    }
    default:
      return false;
  }
}

/**
 * A value is only checked for existing (`toBeTruthy`, `toBeDefined`, `not.toBeNull`,
 * `expect.anything()`), and nothing in the test checks what any value actually is. One assertion
 * that does, on any value, excuses the test: the existence checks are then guards. So does a
 * truthiness check on a value that is already a yes or no, and a helper the rule cannot see into.
 * One finding per test.
 *
 * Warning severity until precision is measured on the corpus.
 */
export const weakMatcher: OracleRule = {
  id: 'oracle/weak-matcher',
  layer: 'oracle',
  meta: {
    evidence: 'moderate',
    summary: 'A value is only checked for existing, not for what it is.',
    penalty: 5,
    cap: 15,
    gate: false,
    severity: 'warn',
  },
  create(ctx) {
    return {
      finish() {
        const findings = [];
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier)) continue;
          // One real check is enough: the existence checks are guards for it.
          const checksAValue = test.assertions.some(
            (a) =>
              a.strength > 1 ||
              a.custom ||
              (TRUTHY.has(a.matcher) && !a.negated && isBooleanValued(a.subject)),
          );
          if (checksAValue) continue;
          const weak = test.assertions.find((a) => a.strength === 1);
          if (!weak) continue;
          findings.push(
            oracleFinding(weakMatcher, ctx.file, {
              test: test.id,
              loc: weak.loc,
              message: `test '${test.id}' only checks that ${weak.subjectText ?? 'a value'} exists (${weak.negated ? 'not.' : ''}${weak.matcher})`,
              hint: 'Assert the expected value, for example `toEqual(...)` or `toBe(...)`.',
            }),
          );
        }
        return findings;
      },
    };
  },
};
