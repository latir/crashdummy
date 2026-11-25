import type { FileScore, Finding, Report } from '../types.js';

/** The agent format is capped here so a hook never floods the model's context. */
export const AGENT_MAX_LINES = 25;
const PER_FILE = 3;

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

function line(f: Finding): string {
  const where = f.loc ? `line ${f.loc.line}` : 'file';
  const fix = f.hint ? ` ${sentence(f.hint)}` : '';
  return `  - ${where}: ${sentence(f.message)}${fix}`;
}

const worthShowing = (f: Finding): boolean => f.severity !== 'info';

/**
 * Plain text for a coding agent: no colours, no box drawing, at most 25 lines, fixes written as
 * instructions. Rule weights are never shown: an agent that sees them optimises for them.
 */
export function formatAgent(report: Report): string {
  const verdict = report.verdict.toUpperCase();
  const count = report.files.length;
  const header = `crashdummy: ${verdict} (${count} file${count === 1 ? '' : 's'})`;
  if (report.verdict === 'pass') return header;

  const body: string[] = [];
  let hidden = 0;
  let hiddenFiles = 0;
  const budget = AGENT_MAX_LINES - 2; // header and footer

  for (const file of report.files) {
    const findings = file.findings.filter(worthShowing);
    if (file.status === 'unparseable') {
      const e = file.error;
      const at = e ? ` (line ${e.line}: ${e.message})` : '';
      const text = `${file.file}: could not parse${at}. Fix the syntax error, then re-run.`;
      if (body.length + 1 <= budget) body.push(text);
      else {
        hidden += 1;
        hiddenFiles += 1;
      }
      continue;
    }
    if (findings.length === 0) continue;

    const shown = findings.slice(0, PER_FILE);
    const need = 1 + shown.length;
    if (body.length + need > budget - 1) {
      hidden += findings.length;
      hiddenFiles += 1;
      continue;
    }
    body.push(fileLine(file));
    for (const f of shown) body.push(line(f));
    hidden += findings.length - shown.length;
  }

  const lines = [header, ...body];
  if (hidden > 0) {
    const where =
      hiddenFiles > 0 ? ` (${hiddenFiles} more file${hiddenFiles === 1 ? '' : 's'})` : '';
    lines.push(
      `${hidden} more finding${hidden === 1 ? '' : 's'}${where} not shown. Fix these first, then re-run.`,
    );
  }
  lines.push('Run `npx crashdummy explain <rule>` for details.');
  return lines.join('\n');
}

function fileLine(file: FileScore): string {
  if (file.status === 'deleted') return `${file.file}  (deleted)`;
  const was = file.previous !== undefined ? ` (was ${file.previous})` : '';
  return `${file.file}  ${file.score}/100${was} · static ${file.subscores.static}`;
}
