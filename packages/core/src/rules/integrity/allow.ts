import type { ParsedFile } from '../../parse/oxc.js';
import { children, type AstNode } from '../../parse/ast.js';

/** A `// crashdummy-allow <rule>[, <rule>]: <reason>` comment. */
export interface AllowDirective {
  rules: string[];
  /** Undefined when the comment has no usable reason. Such a directive allows nothing. */
  reason: string | undefined;
  /** 1-based line where the comment starts. */
  line: number;
  /** The next line with code after the comment, which a `line` directive also covers. */
  targetLine: number;
  /**
   * `file` when the comment comes before the first statement (a header comment), `line` when it
   * sits next to the code it is about.
   */
  scope: 'file' | 'line';
}

const MARKER = /crashdummy-allow\b/;
const DIRECTIVE = /crashdummy-allow\s+([^:]*?)\s*(?::\s*(.*?))?\s*(?:\*\/)?\s*$/;

/** Needs real words, not "-" or "..." or nothing. */
function usableReason(text: string | undefined): string | undefined {
  const reason = text
    ?.trim()
    .replace(/\*+\/?$/, '')
    .trim();
  return reason && /[\p{L}\p{N}]/u.test(reason) ? reason : undefined;
}

/** The first line after `from` that is not just a comment, so other comments may sit in between. */
function nextCodeLine(file: ParsedFile, lines: readonly string[], from: number): number {
  const commentOnly = (line: number): boolean =>
    file.comments.some((c) => {
      if (line < c.line || line > c.endLine) return false;
      if (line > c.line) return true;
      return (lines[line - 1] ?? '').slice(0, c.start - lineStart(file, c.line)).trim() === '';
    });
  let line = from;
  while (line <= lines.length && ((lines[line - 1] ?? '').trim() === '' || commentOnly(line)))
    line++;
  return line;
}

function lineStart(file: ParsedFile, line: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) offset = file.source.indexOf('\n', offset) + 1;
  return offset;
}

export function parseAllowDirectives(file: ParsedFile): AllowDirective[] {
  const lines = file.source.split('\n');
  const firstStatement = children(file.program, 'body')[0] as AstNode | undefined;
  const codeStart = firstStatement ? firstStatement.start : Infinity;
  const out: AllowDirective[] = [];
  for (const comment of file.comments) {
    if (!MARKER.test(comment.value)) continue;
    // a directive is one line; in a block comment it may be any line of it
    const text = comment.value.split('\n').find((l) => MARKER.test(l)) ?? comment.value;
    const m = DIRECTIVE.exec(text.trim().replace(/^\*+\s*/, ''));
    const rules = (m?.[1] ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    out.push({
      rules,
      reason: usableReason(m?.[2]),
      line: comment.line,
      targetLine: nextCodeLine(file, lines, comment.endLine + 1),
      scope: comment.end <= codeStart ? 'file' : 'line',
    });
  }
  return out;
}

/**
 * Does this directive cover a finding of `rule` at `line`? A directive without a reason covers
 * nothing. A `file` directive covers the whole file; a `line` directive covers the line it is on
 * and the next line with code, so other comments may sit between. Findings located in the OLD file (`side: 'before'`, removed tests) can
 * only be covered by a `file` directive, because line numbers of the two versions do not line up.
 */
export function covers(
  directive: AllowDirective,
  rule: string,
  line: number | undefined,
  side: 'before' | 'after',
): boolean {
  if (directive.reason === undefined || !directive.rules.includes(rule)) return false;
  if (directive.scope === 'file') return true;
  if (side === 'before' || line === undefined) return false;
  return line === directive.line || line === directive.targetLine;
}
