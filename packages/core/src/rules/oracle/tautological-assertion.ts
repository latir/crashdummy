import { child, children, isNode, str, unwrap, type AstNode } from '../../parse/ast.js';
import { sourceText } from '../../parse/ast.js';
import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

/** Matchers that compare the subject with an expected value given as the first argument. */
const COMPARES = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject']);
/** `assert.*` methods that compare their first two arguments. */
const ASSERT_COMPARES = new Set([
  'assert.equal',
  'assert.strictEqual',
  'assert.deepEqual',
  'assert.deepStrictEqual',
]);

/** A value written out in the test: nothing from the code under test can be in it. */
function isLiteral(node: AstNode | undefined): boolean {
  if (!node) return false;
  const n = unwrap(node);
  switch (n.type) {
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return children(n, 'expressions').length === 0;
    case 'UnaryExpression': {
      const arg = child(n, 'argument');
      return arg !== undefined && isLiteral(arg);
    }
    case 'Identifier':
      return ['undefined', 'NaN', 'Infinity'].includes(str(n, 'name') ?? '');
    case 'ArrayExpression':
      return children(n, 'elements').every((e) => isNode(e) && isLiteral(e));
    case 'ObjectExpression':
      return children(n, 'properties').every(
        (p) => p.type === 'Property' && p['computed'] !== true && isLiteral(child(p, 'value')),
      );
    default:
      return false;
  }
}

/**
 * A plain name: reading it twice gives the same value. A property read does not: it can run a
 * getter or a Proxy trap, so `expect(store.snapshot).toBe(store.snapshot)` can fail.
 */
function isPlainReference(node: AstNode | undefined): boolean {
  if (!node) return false;
  const n = unwrap(node);
  return n.type === 'Identifier' || n.type === 'ThisExpression';
}

/**
 * An assertion that cannot fail because both sides come from the same place: a literal checked
 * against a literal (`expect(true).toBe(true)`), or a value against itself (`expect(x).toBe(x)`).
 * Where the assertion is inside a helper it is reported once, not once per call.
 */
export const tautologicalAssertion: OracleRule = {
  id: 'oracle/tautological-assertion',
  layer: 'oracle',
  meta: {
    evidence: 'strong',
    summary:
      'An assertion compares a value with itself or a literal with a literal, so it cannot fail.',
    penalty: 15,
    cap: 30,
    gate: true,
    severity: 'error',
  },
  create(ctx) {
    return {
      finish() {
        const findings = [];
        const seen = new Set<AstNode>();
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier)) continue;
          for (const a of test.assertions) {
            // An opaque helper or a matcher we do not know can run the code under test whatever
            // its arguments look like, so only assertions with known meaning are judged.
            if (seen.has(a.node) || a.custom || a.typeLevel || !a.known) continue;
            const args = children(a.node, 'arguments');
            const isAssert = a.matcher.startsWith('assert.');
            const subject = isAssert ? args[0] : a.subject;
            const expected = isAssert ? args[1] : args[0];
            const compares = isAssert ? ASSERT_COMPARES.has(a.matcher) : COMPARES.has(a.matcher);

            // Every value the assertion looks at is written in the test: nothing from the code
            // under test is involved. `expect(200).toBe(getStatus())` still checks `getStatus()`.
            const operands = isAssert ? args : [subject, ...args];
            let why: string | undefined;
            if (isLiteral(subject) && operands.every((o) => isLiteral(o))) {
              why = 'every value it checks is a literal written in the test';
            } else if (
              compares &&
              !a.negated &&
              subject &&
              expected &&
              isPlainReference(subject) &&
              sourceText(ctx.source, unwrap(subject)) === sourceText(ctx.source, unwrap(expected))
            ) {
              why = `'${sourceText(ctx.source, unwrap(subject))}' is compared with itself`;
            }
            if (!why) continue;
            seen.add(a.node);
            findings.push(
              oracleFinding(tautologicalAssertion, ctx.file, {
                test: test.id,
                loc: a.loc,
                message: `${a.matcher} in '${test.id}' cannot fail: ${why}`,
                hint: 'Check a value produced by the code under test against an expected value from the requirement.',
              }),
            );
          }
        }
        return findings;
      },
    };
  },
};
