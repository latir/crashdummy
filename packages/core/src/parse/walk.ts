import { isNode, isTypeOnly, type AstNode, type LineIndex } from './ast.js';

export interface WalkContext {
  readonly path: string;
  readonly source: string;
  /** Ancestors of the node being visited, outermost first. */
  readonly ancestors: readonly AstNode[];
  /** 1-based line and column of an offset. */
  loc(offset: number): { line: number; col: number };
}

export type Handler = (node: AstNode, ctx: WalkContext) => void;

/**
 * Handlers keyed by node type. Use `'CallExpression'` to run on entering a node and
 * `'CallExpression:exit'` to run when leaving it.
 */
export type Visitor = Readonly<Record<string, Handler | undefined>>;

// Type annotations are never needed; skipping them keeps the walk small.
const SKIP_KEYS = new Set([
  'type',
  'start',
  'end',
  'typeAnnotation',
  'typeParameters',
  'typeArguments',
  'returnType',
  'superTypeArguments',
  'superTypeParameters',
  'decorators',
  'implements',
]);

/**
 * One traversal for every registered visitor. N rules cost one walk, not N.
 */
export function walk(
  root: AstNode,
  visitors: readonly Visitor[],
  env: { path: string; source: string; lines: LineIndex },
): void {
  const enter = new Map<string, Handler[]>();
  const exit = new Map<string, Handler[]>();
  for (const visitor of visitors) {
    for (const [key, handler] of Object.entries(visitor)) {
      if (!handler) continue;
      const isExit = key.endsWith(':exit');
      const table = isExit ? exit : enter;
      const type = isExit ? key.slice(0, -5) : key;
      const list = table.get(type);
      if (list) list.push(handler);
      else table.set(type, [handler]);
    }
  }

  const ancestors: AstNode[] = [];
  const ctx: WalkContext = {
    path: env.path,
    source: env.source,
    ancestors,
    loc: (offset) => env.lines.loc(offset),
  };

  const visit = (node: AstNode): void => {
    if (isTypeOnly(node)) return;
    const onEnter = enter.get(node.type);
    if (onEnter) for (const h of onEnter) h(node, ctx);

    ancestors.push(node);
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) {
        visit(value);
      }
    }
    ancestors.pop();

    const onExit = exit.get(node.type);
    if (onExit) for (const h of onExit) h(node, ctx);
  };

  visit(root);
}
