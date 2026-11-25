import { child, isNode, str, unwrap, type AstNode } from '../../parse/ast.js';
import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

const INTERACTION = /^(toHaveBeen(Nth|Last)?Called|toBeCalled|toHave(Last|Nth)?Returned)/;

/** A call whose result is stored or awaited: `const r = f()`, `const r = await f()`. */
function capturesResult(node: AstNode): boolean {
  if (node.type === 'VariableDeclarator') {
    const init = child(node, 'init');
    const value = init ? unwrap(init) : undefined;
    const inner =
      value?.type === 'AwaitExpression' ? unwrap(child(value, 'argument') ?? value) : value;
    if (inner?.type === 'CallExpression') {
      const callee = child(inner, 'callee');
      const name = callee ? unwrap(callee) : undefined;
      // creating a mock is not calling the code under test
      const root = name?.type === 'MemberExpression' ? child(name, 'object') : name;
      const rootName = root ? str(unwrap(root), 'name') : undefined;
      return rootName !== 'vi' && rootName !== 'jest';
    }
  }
  for (const value of Object.values(node)) {
    const kids = Array.isArray(value) ? value : [value];
    for (const k of kids) if (isNode(k) && capturesResult(k)) return true;
  }
  return false;
}

/**
 * Every assertion only checks that something was called. That is fine for code that returns
 * nothing, so the rule stays quiet when the test never captures a result.
 */
export const interactionOnly: OracleRule = {
  id: 'oracle/interaction-only',
  layer: 'oracle',
  meta: {
    evidence: 'moderate',
    summary: 'Every assertion only checks that a function was called, not what came out.',
    penalty: 6,
    cap: 18,
    gate: false,
    severity: 'warn',
  },
  create(ctx) {
    return {
      finish() {
        const findings = [];
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier) || test.assertions.length === 0) continue;
          if (!test.assertions.every((a) => INTERACTION.test(a.matcher))) continue;
          if (!test.body || !capturesResult(test.body)) continue;
          findings.push(
            oracleFinding(interactionOnly, ctx.file, {
              loc: test.assertions[0]!.loc,
              message: `test '${test.id}' only checks that functions were called, not the result it captured`,
              hint: 'Assert on the returned value as well as the calls.',
            }),
          );
        }
        return findings;
      },
    };
  },
};
