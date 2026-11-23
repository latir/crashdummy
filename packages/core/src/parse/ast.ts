/**
 * Internal AST adapter. Everything outside `oxc.ts` works with these types and helpers, so a
 * parser upgrade only ever touches this folder. Nodes are ESTree-shaped.
 */

export interface AstNode {
  type: string;
  /** UTF-16 offsets into the source text. */
  start: number;
  end: number;
  [key: string]: unknown;
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

export function child(node: AstNode, key: string): AstNode | undefined {
  const v = node[key];
  return isNode(v) ? v : undefined;
}

export function children(node: AstNode, key: string): AstNode[] {
  const v = node[key];
  return Array.isArray(v) ? v.filter(isNode) : [];
}

export function str(node: AstNode, key: string): string | undefined {
  const v = node[key];
  return typeof v === 'string' ? v : undefined;
}

const WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

/** Strip parentheses, TypeScript assertions and optional-chain wrappers. */
export function unwrap(node: AstNode): AstNode {
  let n = node;
  while (WRAPPERS.has(n.type)) {
    const inner = child(n, 'expression');
    if (!inner) break;
    n = inner;
  }
  return n;
}

export function isFunction(node: AstNode): boolean {
  return (
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}

/** `'text'` or a template literal with no expressions. */
export function staticString(node: AstNode): string | undefined {
  const n = unwrap(node);
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && children(n, 'expressions').length === 0) {
    const quasi = children(n, 'quasis')[0];
    const value = quasi?.['value'] as { cooked?: string | null } | undefined;
    return value?.cooked ?? undefined;
  }
  return undefined;
}

/** A number, with simple constant folding (`5 * 1000`, `-1`, `1_000 + 500`). */
export function staticNumber(node: AstNode): number | undefined {
  const n = unwrap(node);
  if (n.type === 'Literal') return typeof n.value === 'number' ? n.value : undefined;
  if (n.type === 'UnaryExpression') {
    const arg = child(n, 'argument');
    const v = arg ? staticNumber(arg) : undefined;
    if (v === undefined) return undefined;
    return n['operator'] === '-' ? -v : n['operator'] === '+' ? v : undefined;
  }
  if (n.type === 'BinaryExpression') {
    const l = child(n, 'left');
    const r = child(n, 'right');
    const a = l ? staticNumber(l) : undefined;
    const b = r ? staticNumber(r) : undefined;
    if (a === undefined || b === undefined) return undefined;
    switch (n['operator']) {
      case '*':
        return a * b;
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '/':
        return a / b;
      default:
        return undefined;
    }
  }
  return undefined;
}

/** `a.b.c` as `['a', 'b', 'c']`, or undefined when the expression is not a plain member chain. */
export function memberPath(node: AstNode): string[] | undefined {
  const n = unwrap(node);
  if (n.type === 'Identifier') return [str(n, 'name') ?? ''];
  if (n.type === 'ThisExpression') return ['this'];
  if (n.type !== 'MemberExpression') return undefined;
  const object = child(n, 'object');
  const property = child(n, 'property');
  if (!object || !property) return undefined;
  const base = memberPath(object);
  if (!base) return undefined;
  const key = n['computed'] === true ? staticString(property) : str(property, 'name');
  return key === undefined ? undefined : [...base, key];
}

/** Source text of a node. */
export function sourceText(source: string, node: AstNode): string {
  return source.slice(node.start, node.end);
}

/** Maps offsets to 1-based line and column numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  loc(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo]! + 1 };
  }
}
