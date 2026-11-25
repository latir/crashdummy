import { basename, dirname, extname } from 'node:path';
import { sourceText, type AstNode } from '../../parse/ast.js';
import { oracleFinding } from './finding.js';
import type { OracleRule } from './types.js';

/** `cart.test.ts` and `cart.spec.tsx` test `cart`. */
const testStem = (file: string): string =>
  basename(file)
    .replace(/\.(test|spec)\.[^.]+$/, '')
    .replace(/\.[^.]+$/, '');

/** `./cart.ts` is `cart`; `./cart/index.ts` is also `cart`. */
function moduleStem(path: string): string {
  const name = basename(path, extname(path));
  return name === 'index' ? basename(dirname(path)) : name;
}

/** A factory that starts from the real module keeps the real behaviour: a partial mock. */
function isPartial(factory: AstNode | undefined, source: string): boolean {
  if (!factory) return false;
  return /\b(importOriginal|requireActual|importActual)\b/.test(sourceText(source, factory));
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
          const partial = isPartial(mock.factory, ctx.source);
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
