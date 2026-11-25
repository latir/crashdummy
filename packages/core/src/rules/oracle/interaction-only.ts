import { child, children, isFunction, isNode, str, unwrap, type AstNode } from '../../parse/ast.js';
import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

// `toHaveReturnedWith(x)` and friends check the value that came back, so they are not here
const INTERACTION =
  /^(toHaveBeen(Nth|Last)?Called|toBeCalled|lastCalledWith|nthCalledWith|toHaveReturned(Times)?$|toReturn(Times)?$)/;

/** The name a chain of calls and property reads starts from: `vi` in `vi.fn().mockReturnValue(1)`. */
function chainRoot(node: AstNode): AstNode | undefined {
  let n: AstNode | undefined = unwrap(node);
  for (let guard = 0; n && guard < 50; guard++) {
    if (n.type === 'CallExpression') n = child(n, 'callee');
    else if (n.type === 'MemberExpression') n = child(n, 'object');
    else if (n.type === 'AwaitExpression') n = child(n, 'argument');
    else return n;
    n = n ? unwrap(n) : undefined;
  }
  return undefined;
}

/**
 * A call whose result is stored or awaited: `const r = f()`, `const r = await f()`. Functions
 * inside the test are not looked into: nothing says they run. `mocks` are the names the mocking
 * library goes by (`vi`, `jest`, or what it was imported as).
 */
function capturesResult(node: AstNode, mocks: ReadonlySet<string>): boolean {
  if (node.type === 'VariableDeclarator') {
    const init = child(node, 'init');
    const value = init ? unwrap(init) : undefined;
    const inner =
      value?.type === 'AwaitExpression' ? unwrap(child(value, 'argument') ?? value) : value;
    if (inner?.type === 'CallExpression') {
      // creating or configuring a mock is not calling the code under test: follow the whole
      // chain (`vi.fn().mockResolvedValue(x)`) back to what it starts from
      const root = chainRoot(inner);
      return !(root?.type === 'Identifier' && mocks.has(str(root, 'name') ?? ''));
    }
  }
  for (const value of Object.values(node)) {
    const kids = Array.isArray(value) ? value : [value];
    for (const k of kids) {
      if (isNode(k) && !isFunction(k) && capturesResult(k, mocks)) return true;
    }
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
    const mocks = new Set(['vi', 'jest']);
    return {
      visitor: {
        // `import { vi as mocks } from 'vitest'`: the library under another name
        ImportDeclaration(node) {
          const from = str(child(node, 'source') ?? node, 'value');
          if (from !== 'vitest' && from !== '@jest/globals') return;
          for (const spec of children(node, 'specifiers')) {
            const imported = child(spec, 'imported');
            const local = child(spec, 'local');
            const name = imported ? (str(imported, 'name') ?? str(imported, 'value')) : undefined;
            if ((name === 'vi' || name === 'jest') && local) mocks.add(str(local, 'name') ?? '');
          }
        },
      },
      finish() {
        const findings = [];
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier) || test.assertions.length === 0) continue;
          if (!test.assertions.every((a) => INTERACTION.test(a.matcher))) continue;
          if (!test.body || !capturesResult(test.body, mocks)) continue;
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
