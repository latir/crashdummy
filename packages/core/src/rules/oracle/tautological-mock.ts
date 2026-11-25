import {
  child,
  children,
  isFunction,
  isNode,
  memberPath,
  str,
  unwrap,
  sourceText,
  type AstNode,
} from '../../parse/ast.js';
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
  /** The functions around it, innermost last, and whether the runner calls each itself. */
  fns: { node: AstNode; runner: boolean }[];
  /** A one-shot value: the next call to the mock uses it up. */
  once?: boolean;
  /** For a result: where the call that produced it sits. */
  at?: number;
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

/** Functions the test runner calls itself: setup inside them does run. */
const RUNNER_CALLBACKS = new Set([
  'describe',
  'suite',
  'it',
  'test',
  'beforeEach',
  'beforeAll',
  'afterEach',
  'afterAll',
  'before',
  'after',
]);

/**
 * The functions around a place. Whether code in them runs is decided when the file is done, once
 * we know which functions are test callbacks (aliases and named callbacks included).
 */
function enclosing(ancestors: readonly AstNode[]): Event['fns'] {
  const out: Event['fns'] = [];
  for (let i = 0; i < ancestors.length; i++) {
    const fn = ancestors[i]!;
    if (!isFunction(fn)) continue;
    const call = ancestors[i - 1];
    const callee = call?.type === 'CallExpression' ? child(call, 'callee') : undefined;
    const root = callee ? memberPath(callee)?.[0] : undefined;
    out.push({ node: fn, runner: root !== undefined && RUNNER_CALLBACKS.has(root) });
  }
  return out;
}

/**
 * A value that is the same every time it is written: a literal, a plain name, or (when equality
 * is by value) an array or object of those. A call, or anything that reads through a property,
 * can give a different value each time.
 */
function stable(node: AstNode, byValue: boolean): boolean {
  const n = unwrap(node);
  switch (n.type) {
    case 'Literal':
      return true;
    case 'Identifier':
      return true;
    case 'TemplateLiteral':
      return children(n, 'expressions').length === 0;
    case 'UnaryExpression': {
      const arg = child(n, 'argument');
      return arg !== undefined && n['operator'] !== 'void' && stable(arg, byValue);
    }
    case 'ArrayExpression':
      return byValue && children(n, 'elements').every((e) => isNode(e) && stable(e, byValue));
    case 'ObjectExpression':
      return (
        byValue &&
        children(n, 'properties').every(
          (p) =>
            p.type === 'Property' &&
            p['computed'] !== true &&
            p['method'] !== true &&
            p['kind'] === 'init' &&
            child(p, 'value') !== undefined &&
            stable(child(p, 'value')!, byValue),
        )
      );
    default:
      return false;
  }
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
    /** where each function was called, by what it was called as */
    const calls = new Map<string, number[]>();
    /** A variable now holds the result of a call to `value`, or something we cannot follow. */
    const noteResult = (
      name: string,
      init: AstNode | undefined,
      pos: number,
      ancestors: readonly AstNode[],
    ): void => {
      const call = calledExpression(init);
      const callee = call ? child(call, 'callee') : undefined;
      results.push({
        pos,
        fns: enclosing(ancestors),
        name,
        ...(call ? { at: call.start } : {}),
        value: callee ? target(callee, ctx.source) : '',
      });
    };
    return {
      visitor: {
        CallExpression(node, walk) {
          const callee = child(node, 'callee');
          const c = callee ? unwrap(callee) : undefined;
          if (c) {
            const text = target(c, ctx.source);
            const seen = calls.get(text);
            if (seen) seen.push(node.start);
            else calls.set(text, [node.start]);
          }
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
          returns.push({
            pos: node.start,
            fns: enclosing(walk.ancestors),
            name,
            ...(method.endsWith('Once') ? { once: true } : {}),
            value: unwrap(arg),
          });
        },
        VariableDeclarator(node, walk) {
          const id = child(node, 'id');
          if (id?.type !== 'Identifier') return;
          noteResult(str(id, 'name') ?? '', child(node, 'init'), node.start, walk.ancestors);
        },
        // result = realSut(): the variable no longer holds what it did
        AssignmentExpression(node, walk) {
          const left = child(node, 'left');
          if (node['operator'] !== '=' || left?.type !== 'Identifier') return;
          noteResult(str(left, 'name') ?? '', child(node, 'right'), node.start, walk.ancestors);
        },
      },
      finish() {
        const findings = [];
        const seen = new Set<AstNode>();
        // setup counts when everything around it runs: test callbacks (however they are named or
        // passed) and the runner's own suite and hook callbacks. Other functions are left unknown.
        const testFns = new Set(ctx.facts().flatMap((t) => (t.fn ? [t.fn] : [])));
        const live = (events: readonly Event[]): Event[] =>
          events.filter((e) => e.fns.every((f) => f.runner || testFns.has(f.node)));
        const liveResults = live(results);
        const liveReturns = live(returns);
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
            // the mock is judged as it was when the value was produced, not at the assertion
            let producedAt = a.node.start;
            if (subject.type === 'Identifier') {
              // a variable holds what it was last assigned in this test
              const held = latest(
                liveResults,
                str(subject, 'name') ?? '',
                a.node.start,
                range,
                () => false,
              );
              via = typeof held?.value === 'string' && held.value ? held.value : undefined;
              if (held?.at !== undefined) producedAt = held.at;
            } else if (callee) {
              via = target(callee, ctx.source);
              producedAt = called?.start ?? producedAt;
            }
            if (via === undefined) continue;
            const configured = latest(liveReturns, via, producedAt, range, outsideTests);
            if (!configured || typeof configured.value === 'string') continue;
            if (configured.once) {
              // A one-shot value is used up by the first call. It is the one this result got only
              // if nothing else called the mock in between and no other one-shot value is queued.
              const between = (calls.get(via) ?? []).some(
                (at) => at > configured.pos && at < producedAt,
              );
              const queued = liveReturns.filter(
                (e) =>
                  e.name === via &&
                  e.once &&
                  e.pos < producedAt &&
                  ((range && e.pos >= range.start && e.pos < range.end) || outsideTests(e.pos)),
              );
              if (between || queued.length > 1) continue;
            }
            // Same syntax is the same value only when it is written out the same way every time,
            // and `toBe` compares objects by identity, so only primitives and names qualify there.
            const byValue = a.matcher !== 'toBe';
            const written = unwrap(expected);
            if (!stable(configured.value, byValue) || !stable(written, byValue)) continue;
            if (canon(configured.value) !== canon(written)) continue;
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
