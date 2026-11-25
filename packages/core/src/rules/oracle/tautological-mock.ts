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
const IGNORED_KEYS = new Set(['start', 'end', 'raw', 'loc', 'range', 'parenthesized']);

/**
 * A value's syntax without positions or spelling, so `{ a: 1 }` and `{a:1}` are the same but
 * `'a b'` and `'ab'` are not.
 */
function canon(node: AstNode): string {
  return JSON.stringify(node, (key, value: unknown) =>
    IGNORED_KEYS.has(key) ? undefined : typeof value === 'bigint' ? `${value}n` : value,
  );
}

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

/** Something that happened at a place in the file, found while walking it in order. */
interface Event {
  pos: number;
  /** The mock, or the variable. */
  name: string;
  /** For a mock: what it returns. For a variable: the function whose result it holds. */
  value: AstNode | string;
}

/**
 * The latest event for `name` before `pos` that applies where `pos` is: setup inside the same test
 * first, then setup outside every test (module level, `beforeEach`). Another test's setup says
 * nothing about this one.
 */
function latest(
  events: readonly Event[],
  name: string,
  pos: number,
  inside: { start: number; end: number } | undefined,
  outsideTests: (p: number) => boolean,
): Event | undefined {
  const pick = (applies: (e: Event) => boolean): Event | undefined =>
    events
      .filter((e) => e.name === name && e.pos < pos && applies(e))
      .sort((a, b) => b.pos - a.pos)[0];
  const own = inside ? pick((e) => e.pos >= inside.start && e.pos < inside.end) : undefined;
  return own ?? pick((e) => outsideTests(e.pos));
}

/**
 * The test sets a mock to return X and then asserts that what it got back is X, without the code
 * under test in between. The assertion only checks the mock. Mocks are matched by name, using the
 * setup nearest before the assertion, so reusing a name in another test does not mix them up.
 * Still a name-based check inside one file: a warning, not a gate.
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
    const returns: Event[] = [];
    const results: Event[] = [];
    return {
      visitor: {
        CallExpression(node, walk) {
          const callee = child(node, 'callee');
          const c = callee ? unwrap(callee) : undefined;
          const arg = children(node, 'arguments')[0];
          if (c?.type !== 'MemberExpression' || c['computed'] === true || !arg) return;
          const method = str(child(c, 'property') ?? c, 'name');
          const object = child(c, 'object');
          if (!method || !RETURNS.has(method) || !object) return;
          let name = target(object, ctx.source);
          // `const m = vi.fn().mockReturnValue(X)`: the mock is the variable
          const parent = walk.ancestors[walk.ancestors.length - 1];
          const id = parent?.type === 'VariableDeclarator' ? child(parent, 'id') : undefined;
          if (id?.type === 'Identifier' && /^(vi|jest)\.fn\(/.test(name)) {
            name = str(id, 'name') ?? name;
          }
          returns.push({ pos: node.start, name, value: unwrap(arg) });
        },
        VariableDeclarator(node) {
          const id = child(node, 'id');
          const call = calledExpression(child(node, 'init'));
          const callee = call ? child(call, 'callee') : undefined;
          if (id?.type === 'Identifier' && callee) {
            results.push({
              pos: node.start,
              name: str(id, 'name') ?? '',
              value: target(callee, ctx.source),
            });
          }
        },
      },
      finish() {
        const findings = [];
        const seen = new Set<AstNode>();
        const tests = ctx.facts().filter((t) => t.body);
        const outsideTests = (p: number): boolean =>
          !tests.some((t) => p >= t.body!.start && p < t.body!.end);
        for (const test of ctx.facts()) {
          if (isDisabled(test.modifier)) continue;
          const range = test.body ? { start: test.body.start, end: test.body.end } : undefined;
          for (const a of test.assertions) {
            if (seen.has(a.node) || a.negated || !COMPARES.has(a.matcher) || !a.subject) continue;
            const expected = children(a.node, 'arguments')[0];
            if (!expected) continue;
            const subject = unwrap(a.subject);
            const called = calledExpression(subject);
            const callee = called ? child(called, 'callee') : undefined;
            let via: string | undefined;
            if (subject.type === 'Identifier') {
              // a variable holds what it was last assigned in this test
              const held = latest(
                results,
                str(subject, 'name') ?? '',
                a.node.start,
                range,
                () => false,
              );
              via = typeof held?.value === 'string' ? held.value : undefined;
            } else if (callee) {
              via = target(callee, ctx.source);
            }
            if (via === undefined) continue;
            const configured = latest(returns, via, a.node.start, range, outsideTests);
            if (!configured || typeof configured.value === 'string') continue;
            if (canon(configured.value) !== canon(unwrap(expected))) continue;
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
