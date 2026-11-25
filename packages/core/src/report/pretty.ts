import type { Finding, Report } from '../types.js';

export interface PrettyOptions {
  /** Use ANSI colours. The CLI turns it off for pipes and `NO_COLOR`. */
  color?: boolean;
}

const TOP = 3;

function painter(color: boolean) {
  const wrap = (open: number, close: number) => (s: string) =>
    color ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
  };
}

/** A terminal report: a score per file out of 100, and the top three findings of each. */
export function formatPretty(report: Report, options: PrettyOptions = {}): string {
  const c = painter(options.color ?? false);
  const verdict =
    report.verdict === 'pass'
      ? c.green('PASS')
      : report.verdict === 'warn'
        ? c.yellow('WARN')
        : c.red('FAIL');
  const out: string[] = [];
  const suite = report.suite ? ` · suite ${report.suite.score}/100` : '';
  out.push(
    `${c.bold('crashdummy')} ${verdict} · ${report.files.length} file${report.files.length === 1 ? '' : 's'}${suite} · static estimate`,
  );

  for (const file of report.files) {
    out.push('');
    if (file.status === 'unparseable') {
      const e = file.error;
      out.push(`${c.bold(file.file)}  ${c.yellow('not checked')}`);
      out.push(`  could not parse${e ? ` (line ${e.line}, col ${e.col}: ${e.message})` : ''}`);
    } else if (file.status === 'deleted') {
      out.push(`${c.bold(file.file)}  ${c.dim('deleted')}`);
    } else {
      const was = file.previous !== undefined ? ` (was ${file.previous})` : '';
      out.push(
        `${c.bold(file.file)}  ${file.score}/100${was} ${c.dim(`· static ${file.subscores.static}`)}`,
      );
    }
    const shown = file.findings.filter(
      (f) => f.severity !== 'info' && f.ruleId !== 'integrity/unparseable',
    );
    for (const f of shown.slice(0, TOP)) out.push(...findingLines(f, c));
    if (shown.length > TOP) out.push(c.dim(`  … and ${shown.length - TOP} more`));
  }

  if (report.unknownMatchers && report.unknownMatchers.length > 0) {
    const names = report.unknownMatchers
      .slice(0, 3)
      .map((m) => m.name)
      .join(', ');
    const n = report.unknownMatchers.length;
    out.push('');
    out.push(
      c.dim(
        `${n} matcher${n === 1 ? '' : 's'} not recognised (${names}${n > 3 ? ', …' : ''}). Add them under "matchers" in config.`,
      ),
    );
  }
  out.push('');
  out.push(c.dim('Run `npx crashdummy explain <rule>` for details.'));
  return out.join('\n');
}

function findingLines(f: Finding, c: ReturnType<typeof painter>): string[] {
  const mark = f.gate ? c.red('✖') : c.yellow('!');
  const where = f.loc ? `line ${f.loc.line}` : 'file';
  const lines = [`  ${mark} ${where}  ${f.message}  ${c.dim(f.ruleId)}`];
  if (f.hint) lines.push(`      ${c.dim(f.hint)}`);
  return lines;
}
