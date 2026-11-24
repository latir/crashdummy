import type { ParsedFile } from '../../parse/oxc.js';
import { children, type AstNode } from '../../parse/ast.js';

/** A `// crashdummy-allow <rule>[, <rule>]: <reason>` comment. */
export interface AllowDirective {
  rules: string[];
  /** Undefined when the comment has no usable reason. Such a directive allows nothing. */
  reason: string | undefined;
  /** 1-based line where the comment starts. */
  line: number;
  /**
   * The line a `line` directive also covers: the first line with code after the comment, or the
   * comment's own last line when code follows it there. Undefined for a trailing comment, which
   * covers only its own line.
   */
  targetLine: number | undefined;
  /**
   * `file` when the comment comes before the first statement (a header comment), `line` when it
   * sits next to the code it is about.
   */
  scope: 'file' | 'line';
}

/**
 * A directive starts a comment line (after whitespace, or the `*` of a block comment). A comment
 * that merely mentions it, such as `// Example: crashdummy-allow ...`, is documentation and
 * must not switch a gate off.
 */
const MARKER = /^\s*\*?\s*crashdummy-allow\b/;
const DIRECTIVE = /crashdummy-allow\s+([^:]*?)\s*(?::\s*(.*?))?\s*(?:\*\/)?\s*$/;

/** Needs real words, not "-" or "..." or nothing. */
function usableReason(text: string | undefined): string | undefined {
  const reason = text
    ?.trim()
    .replace(/\*+\/?$/, '')
    .trim();
  return reason && /[\p{L}\p{N}]/u.test(reason) ? reason : undefined;
}

/**
 * The lines of a file with every comment blanked out, so "is there code on this line" is a plain
 * question, whatever mix of comments and code the line holds.
 */
function codeLines(file: ParsedFile): { lines: string[]; starts: number[] } {
  const starts = [0];
  for (let i = 0; i < file.source.length; i++) if (file.source[i] === '\n') starts.push(i + 1);
  const lines = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : file.source.length;
    let text = file.source.slice(start, end);
    for (const c of file.comments) {
      if (c.end <= start || c.start >= end) continue;
      const from = Math.max(c.start, start) - start;
      const to = Math.min(c.end, end) - start;
      text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to);
    }
    return text;
  });
  return { lines, starts };
}

export function parseAllowDirectives(file: ParsedFile): AllowDirective[] {
  const firstStatement = children(file.program, 'body')[0] as AstNode | undefined;
  const codeStart = firstStatement ? firstStatement.start : Infinity;
  const { lines, starts } = codeLines(file);
  const hasCode = (line: number): boolean => (lines[line - 1] ?? '').trim() !== '';
  const out: AllowDirective[] = [];

  for (const comment of file.comments) {
    // a directive is one line; in a block comment it may be any line of it
    const text = comment.value.split('\n').find((l) => MARKER.test(l));
    if (text === undefined) continue;
    const m = DIRECTIVE.exec(text.trim().replace(/^\*+\s*/, ''));
    const rules = (m?.[1] ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    const before = (lines[comment.line - 1] ?? '').slice(
      0,
      comment.start - starts[comment.line - 1]!,
    );
    const after = (lines[comment.endLine - 1] ?? '').slice(
      comment.end - starts[comment.endLine - 1]!,
    );
    let targetLine: number | undefined;
    if (before.trim() !== '') {
      targetLine = undefined; // trailing: the code it is about is on its own line
    } else if (after.trim() !== '') {
      targetLine = comment.endLine; // code follows the comment on the same line
    } else {
      targetLine = comment.endLine + 1;
      while (targetLine <= lines.length && !hasCode(targetLine)) targetLine++;
    }

    out.push({
      rules,
      reason: usableReason(m?.[2]),
      line: comment.line,
      targetLine,
      scope: comment.end <= codeStart ? 'file' : 'line',
    });
  }
  return out;
}

/**
 * Does this directive cover a finding of `rule` at `line`? A directive without a reason covers
 * nothing. A `file` directive covers the whole file; a `line` directive covers the line it is on
 * and, when it stands on its own, the next line with code (other comments may sit between). A
 * trailing comment covers only its own line. Findings located in the OLD file
 * (`side: 'before'`, removed tests) can only be covered by a `file` directive, because line
 * numbers of the two versions do not line up.
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
