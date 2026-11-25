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

/** Does this expression get the real module: `await importOriginal()`, `jest.requireActual(x)`? */
function readsOriginal(node: AstNode, original: string | undefined): boolean {
  for (const n of descendants(node)) {
    if (n.type !== 'CallExpression') continue;
    const callee = child(n, 'callee');
    const c = callee ? unwrap(callee) : undefined;
    if (c?.type === 'Identifier') {
      const name = str(c, 'name');
      if (name !== undefined && (name === original || ACTUAL_CALLS.has(name))) return true;
    } else if (c?.type === 'MemberExpression' && c['computed'] !== true) {
      const name = str(child(c, 'property') ?? c, 'name');
      if (name !== undefined && ACTUAL_CALLS.has(name)) return true;
    }
  }
  return false;
}

/**
 * A factory that spreads the real module into what it returns keeps the real behaviour: a
 * partial mock. It counts only when the spread comes from the real module, directly
 * (`...(await importOriginal())`) or through a variable (`const actual = await importOriginal()`),
 * not when the factory merely takes the parameter.
 */
function isPartial(factory: AstNode | undefined): boolean {
  if (!factory || !isFunction(factory)) return false;
  const first = children(factory, 'params')[0];
  const original = first?.type === 'Identifier' ? str(first, 'name') : undefined;
  const fromOriginal = new Set<string>();
  for (const n of descendants(factory)) {
    if (n.type !== 'VariableDeclarator') continue;
    const id = child(n, 'id');
    const init = child(n, 'init');
    if (id?.type === 'Identifier' && init && readsOriginal(init, original)) {
      fromOriginal.add(str(id, 'name') ?? '');
    }
  }
  for (const n of descendants(factory)) {
    if (n.type !== 'SpreadElement') continue;
    const arg = child(n, 'argument');
    if (!arg) continue;
    const a = unwrap(arg);
    if (readsOriginal(a, original)) return true;
    if (a.type === 'Identifier' && fromOriginal.has(str(a, 'name') ?? '')) return true;
  }
  return false;
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
