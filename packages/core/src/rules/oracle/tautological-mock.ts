import { child, children, str, unwrap, sourceText, type AstNode } from '../../parse/ast.js';
import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

const RETURNS = new Set([
  'mockReturnValue',
  'mockReturnValueOnce',
  'mockResolvedValue',
  'mockResolvedValueOnce',
]);
const COMPARES = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject']);

const squash = (text: string): string => text.replace(/\s+/g, '');

/** `vi.mocked(api.get)` is `api.get`. */
function target(node: AstNode, source: string): string {
  const n = unwrap(node);
  if (n.type === 'CallExpression') {
    const callee = child(n, 'callee');
    const name = callee ? sourceText(source, unwrap(callee)) : '';
    const arg = children(n, 'arguments')[0];
    if (/^(vi|jest)\.mocked$/.test(name) && arg) return sourceText(source, unwrap(arg));
  }
  return sourceText(source, n);
}

/** The call inside `m()` or `await m()`, or undefined. */
function calledExpression(node: AstNode | undefined): AstNode | undefined {
  if (!node) return undefined;
  let n = unwrap(node);
  if (n.type === 'AwaitExpression') {
    const arg = child(n, 'argument');
    if (!arg) return undefined;
    n = unwrap(arg);
  }
  return n.type === 'CallExpression' ? n : undefined;
}

/**
 * The test sets a mock to return X and then asserts that what it got back is X, without the code
 * under test in between. The assertion only checks the mock. The check is by name inside one file
 * (`m`, `api.get`), so it is a warning, not a gate.
 */
export const tautologicalMock: OracleRule = {
  id: 'oracle/tautological-mock',
  layer: 'oracle',
  meta: {
    evidence: 'moderate',
    summary: 'The test sets a mock to return a value and then asserts that value comes back.',
    penalty: 12,
    cap: 24,
    gate: false,
    severity: 'warn',
  },
  create(ctx) {
    /** mock name -> what it was told to return, whitespace removed */
    const returns = new Map<string, string>();
    /** variable -> the mock it was assigned a call result of */
    const results = new Map<string, string>();
    return {
      visitor: {
        CallExpression(node, walk) {
          const callee = child(node, 'callee');
          const c = callee ? unwrap(callee) : undefined;
          const arg = children(node, 'arguments')[0];
          if (c?.type === 'MemberExpression' && c['computed'] !== true && arg) {
            const method = str(child(c, 'property') ?? c, 'name');
            const object = child(c, 'object');
            if (method && RETURNS.has(method) && object) {
              let key = target(object, ctx.source);
              // `const m = vi.fn().mockReturnValue(X)`: the mock is the variable
              const parent = walk.ancestors[walk.ancestors.length - 1];
              const id = parent?.type === 'VariableDeclarator' ? child(parent, 'id') : undefined;
              if (id?.type === 'Identifier' && /^(vi|jest)\.fn\(/.test(key)) {
                key = str(id, 'name') ?? key;
              }
              returns.set(key, squash(sourceText(ctx.source, unwrap(arg))));
            }
          }
        },
        VariableDeclarator(node) {
          const id = child(node, 'id');
          const call = calledExpression(child(node, 'init'));
          const callee = call ? child(call, 'callee') : undefined;
          if (id?.type === 'Identifier' && callee) {
            results.set(str(id, 'name') ?? '', target(callee, ctx.source));
          }
        },
      },
      finish() {
        const findings = [];
        const seen = new Set<AstNode>();
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier)) continue;
          for (const a of test.assertions) {
            if (seen.has(a.node) || a.negated || !COMPARES.has(a.matcher) || !a.subject) continue;
            const expected = children(a.node, 'arguments')[0];
            if (!expected) continue;
            const subject = unwrap(a.subject);
            const called = calledExpression(subject);
            const callee = called ? child(called, 'callee') : undefined;
            const via =
              subject.type === 'Identifier'
                ? results.get(str(subject, 'name') ?? '')
                : callee
                  ? target(callee, ctx.source)
                  : undefined;
            const configured = via === undefined ? undefined : returns.get(via);
            if (configured === undefined) continue;
            if (squash(sourceText(ctx.source, unwrap(expected))) !== configured) continue;
            seen.add(a.node);
            findings.push(
              oracleFinding(tautologicalMock, ctx.file, {
                loc: a.loc,
                message: `'${test.id}' sets '${via}' to return a value and asserts that same value`,
                hint: 'Call the code under test and assert on what it does with the mock’s value.',
              }),
            );
          }
        }
        return findings;
      },
    };
  },
};
