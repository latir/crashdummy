import type { Report } from '../types.js';
import { formatAgent } from './agent.js';
import { formatJson } from './json.js';
import { formatPretty, type PrettyOptions } from './pretty.js';

export type ReportFormat = 'pretty' | 'agent' | 'json';
export const REPORT_FORMATS: readonly ReportFormat[] = ['pretty', 'agent', 'json'];

export function formatReport(
  report: Report,
  format: ReportFormat,
  options: PrettyOptions = {},
): string {
  if (format === 'agent') return formatAgent(report);
  if (format === 'json') return formatJson(report);
  return formatPretty(report, options);
}

export { formatAgent, AGENT_MAX_LINES } from './agent.js';
export { formatJson } from './json.js';
export { formatPretty, type PrettyOptions } from './pretty.js';
export { explainRule, explainMatchers, explainableRules } from './explain.js';
