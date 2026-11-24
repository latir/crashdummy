import { parseSync } from 'oxc-parser';
import { LineIndex, type AstNode } from './ast.js';

/** The only file that imports `oxc-parser`. */
export interface ParseDiagnostic {
  message: string;
  /** 1-based position of the error in the source. */
  line: number;
  col: number;
}

export interface ParsedFile {
  path: string;
  source: string;
  program: AstNode;
  /** Syntax errors. When there are any, `program` is empty: oxc does not recover. */
  errors: readonly ParseDiagnostic[];
  lines: LineIndex;
}

export function parseFile(path: string, source: string): ParsedFile {
  const result = parseSync(path, source, { preserveParens: false });
  const lines = new LineIndex(source);
  return {
    path,
    source,
    program: result.program as unknown as AstNode,
    errors: result.errors.map((e) => ({
      message: e.message,
      ...lines.loc(e.labels[0]?.start ?? 0),
    })),
    lines,
  };
}
