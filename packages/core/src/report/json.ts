import type { Report } from '../types.js';

/** The `Report`, versioned and stable, for adapters and scripts. */
export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}
