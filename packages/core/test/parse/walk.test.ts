import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  analyzeTestFile,
  memberPath,
  staticString,
  child,
  children,
  type AstNode,
  type Visitor,
} from '../../src/parse/index.js';

const SOURCE = `
import { test, expect } from 'vitest';
describe('d', () => {
  test('a', () => { expect(1).toBe(1); });
  test('b', () => { expect(2).toBe(2); });
});
`;

describe('shared walk', () => {
  test('N rule visitors share one traversal', () => {
    let programs = 0;
    const seenByA: string[] = [];
    const seenByB: string[] = [];
    const a: Visitor = {
      Program: () => void programs++,
      CallExpression: (n) =>
        void seenByA.push(memberPath(child(n, 'callee')!)?.join('.') ?? '<chain>'),
    };
    const b: Visitor = {
      Program: () => void programs++,
      CallExpression: (n) =>
        void seenByB.push(memberPath(child(n, 'callee')!)?.join('.') ?? '<chain>'),
    };
    analyzeTestFile('a.test.ts', SOURCE, { resolve: false, visitors: [a, b] });
    expect(programs).toBe(2); // once per visitor, from a single walk
    expect(seenByA).toEqual(seenByB);
    // depth first: describe, then per test the outer expect(..).toBe(..) chain and the inner expect(..)
    expect(seenByA).toEqual(['describe', 'test', '<chain>', 'expect', 'test', '<chain>', 'expect']);
  });

  test('rule visitors run alongside the summary builder', () => {
    const titles: string[] = [];
    const rule: Visitor = {
      CallExpression(node) {
        const callee = child(node, 'callee');
        if (callee && memberPath(callee)?.join('.') === 'test') {
          const arg = children(node, 'arguments')[0];
          titles.push(arg ? (staticString(arg) ?? '?') : '?');
        }
      },
    };
    const { summary } = analyzeTestFile('a.test.ts', SOURCE, { resolve: false, visitors: [rule] });
    expect(titles).toEqual(['a', 'b']);
    expect(summary.tests).toHaveLength(2);
  });

  test('enter and :exit are called in order, with ancestors and locations', () => {
    const log: string[] = [];
    const v: Visitor = {
      ExpressionStatement: (n, ctx) => {
        if (ctx.ancestors.length === 1) log.push(`enter@${ctx.loc(n.start).line}`);
      },
      'ExpressionStatement:exit': (n, ctx) => {
        if (ctx.ancestors.length === 1) log.push(`exit@${ctx.loc(n.start).line}`);
      },
    };
    analyzeTestFile('a.test.ts', `a();\nb();`, { resolve: false, visitors: [v] });
    expect(log).toEqual(['enter@1', 'exit@1', 'enter@2', 'exit@2']);
  });

  test('type annotations and type-only nodes are not entered', () => {
    const types: string[] = [];
    const all: string[] = [];
    const collect: Visitor = {
      Identifier: (n) => void all.push(String(n['name'])),
      TSTypeReference: (n) => void types.push(n.type),
    };
    analyzeTestFile('a.test.ts', `const x: Foo = bar as Baz; interface I { a: string }`, {
      resolve: false,
      visitors: [collect],
    });
    expect(types).toEqual([]);
    expect(all).toEqual(['x', 'bar']); // not Foo, Baz, I, a
  });
});

describe('AST adapter boundary', () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  test('only parse/oxc.ts imports oxc-parser', () => {
    const importers = files(src).filter((f) =>
      /from ['"]oxc-parser['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(importers.map((f) => f.slice(src.length + 1))).toEqual(['parse/oxc.ts']);
  });

  test('visitors can be written against AstNode alone', () => {
    const node: AstNode = { type: 'Identifier', start: 0, end: 1, name: 'x' };
    expect(node.type).toBe('Identifier');
  });
});
