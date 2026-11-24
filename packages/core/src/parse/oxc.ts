import { parseSync } from 'oxc-parser';
import { LineIndex, type AstNode } from './ast.js';

/** The only file that imports `oxc-parser`. */
export interface ParseDiagnostic {
  message: string;
  /** 1-based position of the error in the source. */
  line: number;
  col: number;
}

export interface ParsedComment {
  type: 'Line' | 'Block';
  /** The text without the comment markers. */
  value: string;
  start: number;
  end: number;
  /** 1-based line where the comment starts and where it ends. */
  line: number;
  endLine: number;
}

export interface ParsedFile {
  path: string;
  source: string;
  program: AstNode;
  comments: readonly ParsedComment[];
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
    comments: result.comments.map((c) => ({
      type: c.type,
      value: c.value,
      start: c.start,
      end: c.end,
      line: lines.loc(c.start).line,
      endLine: lines.loc(Math.max(c.start, c.end - 1)).line,
    })),
    errors: result.errors.map((e) => ({
      message: e.message,
      ...lines.loc(e.labels[0]?.start ?? 0),
    })),
    lines,
  };
}
