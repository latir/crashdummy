import { basename, dirname, extname } from 'node:path';
import { child, children, isFunction, isNode, str, unwrap, type AstNode } from '../../parse/ast.js';
import { oracleFinding } from './finding.js';
import type { OracleRule } from './types.js';

/** `cart.test.ts` and `cart.spec.tsx` test `cart`. */
const testStem = (file: string): string => basename(file).replace(/(\.(test|spec))?\.[^.]+$/, '');

/** `./cart.ts` is `cart`; `./cart/index.ts` is also `cart`. */
function moduleStem(path: string): string {
  const name = basename(path, extname(path));
  return name === 'index' ? basename(dirname(path)) : name;
}

const ACTUAL_CALLS = new Set(['requireActual', 'importActual']);

function* descendants(node: AstNode): Generator<AstNode> {
  yield node;
  for (const value of Object.values(node)) {
    for (const k of Array.isArray(value) ? value : [value]) if (isNode(k)) yield* descendants(k);
  }
}

/**
 * Is this expression the real module itself: `await importOriginal()`, `jest.requireActual(x)`,
 * `vi.importActual(x)`? A call to it somewhere inside a larger value does not make the whole
 * value the real module.
 */
function isOriginalCall(node: AstNode, original: string | undefined): boolean {
  let n = unwrap(node);
  if (n.type === 'AwaitExpression') {
    const arg = child(n, 'argument');
    if (!arg) return false;
    n = unwrap(arg);
  }
  if (n.type !== 'CallExpression') return false;
  const callee = child(n, 'callee');
  const c = callee ? unwrap(callee) : undefined;
  if (c?.type === 'Identifier') {
    const name = str(c, 'name');
    return name !== undefined && (name === original || ACTUAL_CALLS.has(name));
  }
  if (c?.type === 'MemberExpression' && c['computed'] !== true) {
    const name = str(child(c, 'property') ?? c, 'name');
    return name !== undefined && ACTUAL_CALLS.has(name);
  }
  return false;
}

/** What a function hands back: an arrow's expression body, or each `return`, not nested ones. */
function returnedValues(fn: AstNode): AstNode[] {
  const body = child(fn, 'body');
  if (!body) return [];
  if (body.type !== 'BlockStatement') return [unwrap(body)];
  const out: AstNode[] = [];
  const visit = (node: AstNode): void => {
    if (isFunction(node)) return;
    if (node.type === 'ReturnStatement') {
      const arg = child(node, 'argument');
      if (arg) out.push(unwrap(arg));
      return;
    }
    for (const value of Object.values(node)) {
      for (const k of Array.isArray(value) ? value : [value]) if (isNode(k)) visit(k);
    }
  };
  for (const statement of children(body, 'body')) visit(statement);
  return out;
}

/**
 * A factory that returns the real module's exports with some replaced keeps the real behaviour: a
 * partial mock. It counts only when what is returned spreads the real module, directly
 * (`...(await importOriginal())`) or through a variable that holds it, or is the real module
 * itself. A spread into an object that is never returned changes nothing, and neither does merely
 * taking the parameter.
 */
function isPartial(factory: AstNode | undefined): boolean {
  if (!factory || !isFunction(factory)) return false;
  const first = children(factory, 'params')[0];
  const original = first?.type === 'Identifier' ? str(first, 'name') : undefined;
  const declared = new Map<string, AstNode>();
  const fromOriginal = new Set<string>();
  for (const n of descendants(factory)) {
    if (n.type !== 'VariableDeclarator') continue;
    const id = child(n, 'id');
    const init = child(n, 'init');
    if (id?.type !== 'Identifier' || !init) continue;
    const name = str(id, 'name') ?? '';
    declared.set(name, unwrap(init));
    if (isOriginalCall(init, original)) fromOriginal.add(name);
  }
  const keepsOriginal = (expr: AstNode, depth = 0): boolean => {
    const e = unwrap(expr);
    if (e.type === 'ObjectExpression') {
      return children(e, 'properties').some((p) => {
        const arg = p.type === 'SpreadElement' ? child(p, 'argument') : undefined;
        return arg !== undefined && keepsOriginal(arg, depth + 1);
      });
    }
    if (e.type === 'Identifier') {
      const name = str(e, 'name') ?? '';
      if (fromOriginal.has(name)) return true;
      const init = declared.get(name);
      return depth < 3 && init !== undefined && init.type === 'ObjectExpression'
        ? keepsOriginal(init, depth + 1)
        : false;
    }
    return isOriginalCall(e, original);
  };
  return returnedValues(factory).some((value) => keepsOriginal(value));
}

/**
 * The test replaces the module it is testing, so it checks the replacement, not the code. The
 * module under test is the one the test file is named after (`cart.test.ts` and `./cart`). When no
 * import matches the name, the subject is unknown and the rule stays quiet.
 *
 * A partial mock (the factory spreads the real module) is only a warning. Both are warnings, not
 * gates, until precision is measured on the corpus (CD-6).
 */
export const mocksSubject: OracleRule = {
  id: 'oracle/mocks-subject',
  layer: 'oracle',
  meta: {
    evidence: 'moderate',
    summary: 'The test mocks the module it is supposed to test.',
    penalty: 15,
    cap: 30,
    gate: false,
    severity: 'warn',
  },
  create(ctx) {
    return {
      finish() {
        const stem = testStem(ctx.file);
        const subjects = ctx
          .summary()
          .imports.filter((imp) => moduleStem(imp) === stem && !imp.startsWith('node:'));
        if (subjects.length === 0) return [];
        const findings = [];
        for (const mock of ctx.mocks()) {
          const resolved = ctx.resolve(mock.spec);
          if (!subjects.includes(resolved)) continue;
          const partial = isPartial(mock.factory);
          const f = oracleFinding(mocksSubject, ctx.file, {
            loc: mock.loc,
            message: partial
              ? `'${mock.spec}' is the module under test and is partly mocked`
              : `'${mock.spec}' is the module under test and is replaced by a mock`,
            hint: partial
              ? 'Keep the real implementation of the functions this test exercises, and mock only what they depend on.'
              : 'Mock the module’s dependencies, not the module itself.',
          });
          if (partial) f.penalty = 0;
          findings.push(f);
        }
        return findings;
      },
    };
  },
};
