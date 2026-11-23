import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestSummary } from '../../src/types.js';
import { analyzeTestFile, type AnalyzeOptions } from '../../src/parse/index.js';

export function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../fixtures/parse/${name}`, import.meta.url)),
    'utf8',
  );
}

/** Summarize a fixture or inline source with imports kept as written. */
export function summarize(name: string, source: string, options: AnalyzeOptions = {}): TestSummary {
  return analyzeTestFile(name, source, { resolve: false, ...options }).summary;
}

export function summarizeFixture(name: string, options: AnalyzeOptions = {}): TestSummary {
  return summarize(name, fixture(name), options);
}

/** `name:strength`, with `!` for negated and `@mock` for a mock subject. */
export function shape(summary: TestSummary): Record<string, string[]> {
  return Object.fromEntries(
    summary.tests.map((t) => [
      t.id,
      t.matchers.map(
        (m) => `${m.negated ? '!' : ''}${m.name}:${m.strength}${m.subjectIsMock ? '@mock' : ''}`,
      ),
    ]),
  );
}
