import {
  child,
  children,
  isFunction,
  memberPath,
  str,
  unwrap,
  type AstNode,
} from '../../parse/ast.js';
import { oracleFinding, isDisabled } from './finding.js';
import type { OracleRule } from './types.js';

const PROMISE_CHAINS = new Set(['then', 'catch', 'finally']);
const PROMISE_COMBINATORS = new Set([
  'Promise.all',
  'Promise.allSettled',
  'Promise.race',
  'Promise.any',
]);

/** The names along `a.b.c(...)`'s callee, outermost property first: `['c', 'b']`. */
function calleeProperties(call: AstNode): string[] {
  const names: string[] = [];
  let n: AstNode | undefined = child(call, 'callee');
  n = n ? unwrap(n) : undefined;
  while (n?.type === 'MemberExpression') {
    const p = child(n, 'property');
    const name = p && n['computed'] !== true ? str(p, 'name') : undefined;
    if (name) names.push(name);
    const o = child(n, 'object');
    n = o ? unwrap(o) : undefined;
  }
  return names;
}

/**
 * Whether the promise this expression makes is waited for, from its ancestors (nearest last).
 * Anything we cannot tell (stored in a variable, passed to an unknown function) counts as handled:
 * this is a gate, so only a promise that is plainly dropped is reported.
 */
function isHandled(ancestors: readonly AstNode[], node: AstNode): boolean {
  let current = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i]!;
    switch (parent.type) {
      case 'ExpressionStatement':
      case 'BlockStatement':
      case 'Program':
        return false;
      case 'ArrowFunctionExpression':
        return child(parent, 'body') === current; // `() => promise` returns it
      case 'ArrayExpression':
      case 'MemberExpression':
      case 'ConditionalExpression':
      case 'LogicalExpression':
      case 'SequenceExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
        current = parent;
        break;
      case 'CallExpression': {
        const callee = child(parent, 'callee');
        if (callee === current) {
          current = parent; // `.then(...)` on the promise: the chain's result is what matters
          break;
        }
        const path = callee ? memberPath(callee)?.join('.') : undefined;
        if (path && PROMISE_COMBINATORS.has(path)) {
          current = parent;
          break;
        }
        return true; // handed to something we cannot see into
      }
      default:
        return true; // await, return, a variable, an argument...
    }
  }
  return true;
}

/**
 * An assertion whose failure nothing waits for: `expect(p).resolves.toBe(1)` without `await` or
 * `return`, `expect` inside a `.then(...)` whose promise is dropped, or an `async` test that also
 * takes `done`. The test finishes first and passes whatever the assertion finds.
 */
export const swallowedAsync: OracleRule = {
  id: 'oracle/swallowed-async',
  layer: 'oracle',
  meta: {
    evidence: 'strong',
    summary: 'An asynchronous assertion is not awaited, so its failure cannot fail the test.',
    penalty: 10,
    cap: 20,
    gate: true,
    severity: 'error',
  },
  create(ctx) {
    // Remembered during the walk: where each interesting call sits.
    const resolves = new Map<AstNode, readonly AstNode[]>();
    const chains: { node: AstNode; callbacks: AstNode[]; ancestors: readonly AstNode[] }[] = [];
    return {
      visitor: {
        CallExpression(node, walkCtx) {
          const props = calleeProperties(node);
          if (props.includes('resolves') || props.includes('rejects')) {
            resolves.set(node, walkCtx.ancestors.slice(-8));
          }
          if (props[0] && PROMISE_CHAINS.has(props[0])) {
            const callbacks = children(node, 'arguments').map(unwrap).filter(isFunction);
            if (callbacks.length > 0) {
              chains.push({ node, callbacks, ancestors: walkCtx.ancestors.slice(-8) });
            }
          }
        },
      },
      finish() {
        const findings = [];
        const seen = new Set<AstNode>();
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier)) continue;
          const first = test.fn ? children(test.fn, 'params')[0] : undefined;
          if (
            test.fn &&
            test.fn['async'] === true &&
            first?.type === 'Identifier' &&
            str(first, 'name') === 'done'
          ) {
            findings.push(
              oracleFinding(swallowedAsync, ctx.file, {
                loc: test.loc,
                message: `test '${test.id}' is async and also takes 'done'`,
                hint: 'Use either an async function or the done callback, not both.',
              }),
            );
          }
          for (const a of test.assertions) {
            if (seen.has(a.node)) continue;
            const ancestors = resolves.get(a.node);
            if (ancestors && !isHandled(ancestors, a.node)) {
              seen.add(a.node);
              findings.push(
                oracleFinding(swallowedAsync, ctx.file, {
                  loc: a.loc,
                  message: `${a.matcher} in '${test.id}' is not awaited, so a failure is lost`,
                  hint: 'Put `await` (or `return`) in front of `expect(...).resolves` / `.rejects`.',
                }),
              );
              continue;
            }
            const chain = chains.find(
              (c) =>
                !isHandled(c.ancestors, c.node) &&
                c.callbacks.some((cb) => cb.start <= a.node.start && a.node.end <= cb.end),
            );
            if (chain) {
              seen.add(a.node);
              findings.push(
                oracleFinding(swallowedAsync, ctx.file, {
                  loc: a.loc,
                  message: `${a.matcher} in '${test.id}' runs inside a promise callback the test does not wait for`,
                  hint: 'Return the promise or `await` it, so the test waits for the assertion.',
                }),
              );
            }
          }
        }
        return findings;
      },
    };
  },
};
