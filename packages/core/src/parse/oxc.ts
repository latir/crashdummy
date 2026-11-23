import { parseSync } from 'oxc-parser';
import { LineIndex, type AstNode } from './ast.js';

/** The only file that imports `oxc-parser`. */
export interface ParsedFile {
  path: string;
  source: string;
  program: AstNode;
  /** Syntax errors. When there are any, `program` is empty: oxc does not recover. */
  errors: readonly string[];
  lines: LineIndex;
}

export function parseFile(path: string, source: string): ParsedFile {
  const result = parseSync(path, source, { preserveParens: false });
  return {
    path,
    source,
    program: result.program as unknown as AstNode,
    errors: result.errors.map((e) => e.message),
    lines: new LineIndex(source),
  };
}
