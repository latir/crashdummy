import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { TestSummary } from '../types.js';
import { SUMMARY_VERSION, hashText, type SummaryOptions } from './summary.js';

const FRAMEWORKS = new Set(['vitest', 'jest', 'playwright', 'node-test', 'unknown']);
const MODIFIERS = new Set(['skip', 'only', 'todo', 'fixme', 'fails']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isPos = (v: unknown): boolean =>
  isRecord(v) && Number.isInteger(v['line']) && Number.isInteger(v['col']);

function isMatcherUse(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v['name'] === 'string' &&
    (v['strength'] === 1 || v['strength'] === 2 || v['strength'] === 3 || v['strength'] === 4) &&
    typeof v['negated'] === 'boolean' &&
    typeof v['subjectIsMock'] === 'boolean' &&
    (v['chain'] === undefined || typeof v['chain'] === 'string') &&
    (v['rank'] === undefined || Number.isInteger(v['rank']))
  );
}

function isTestCase(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['bodyHash'] === 'string' &&
    isPos(v['loc']) &&
    (v['modifier'] === undefined || MODIFIERS.has(v['modifier'] as string)) &&
    (v['modifiers'] === undefined ||
      (Array.isArray(v['modifiers']) &&
        v['modifiers'].every(
          (m) => isRecord(m) && MODIFIERS.has(m['modifier'] as string) && isPos(m['loc']),
        ))) &&
    (v['timeoutMs'] === undefined || typeof v['timeoutMs'] === 'number') &&
    Array.isArray(v['matchers']) &&
    v['matchers'].every(isMatcherUse)
  );
}

/** Is this really a `TestSummary`? Anything read from disk must pass before it is trusted. */
export function isTestSummary(v: unknown): v is TestSummary {
  return (
    isRecord(v) &&
    typeof v['hash'] === 'string' &&
    FRAMEWORKS.has(v['framework'] as string) &&
    Array.isArray(v['imports']) &&
    v['imports'].every((i) => typeof i === 'string') &&
    Array.isArray(v['tests']) &&
    v['tests'].every(isTestCase)
  );
}

/** Where the plan keeps the persisted cache, relative to the repo root. */
export const DEFAULT_CACHE_FILE = '.crashdummy/cache/summaries.json';

/**
 * Everything besides the file content that changes what a summary contains. The extension is
 * part of it because oxc picks the language from it: the same text can be valid in `.ts` and a
 * syntax error in `.js`. Files with the same extension still share entries.
 */
export function cacheKey(contentHash: string, path: string, options: SummaryOptions): string {
  const fingerprint = hashText(
    JSON.stringify([
      SUMMARY_VERSION,
      [...(options.assertFunctionNames ?? [])].sort(),
      options.matchers ?? {},
    ]),
  );
  return `${fingerprint}:${extname(path).toLowerCase()}:${contentHash}`;
}

/**
 * Summaries keyed by content hash: an unchanged file is never parsed again. Entries hold the
 * unresolved summary, because import resolution depends on the file system, not on the content.
 * Oldest entries are dropped past `maxEntries`.
 */
export class SummaryCache {
  private readonly entries = new Map<string, TestSummary>();

  constructor(private readonly maxEntries = 5000) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): TestSummary | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // refresh recency
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, summary: TestSummary): void {
    this.entries.delete(key);
    this.entries.set(key, summary);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Load a cache file. A missing, unreadable or outdated file gives an empty cache. */
  static load(file: string, maxEntries?: number): SummaryCache {
    const cache = new SummaryCache(maxEntries);
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        v?: number;
        entries?: Record<string, TestSummary>;
      };
      if (data.v !== SUMMARY_VERSION || typeof data.entries !== 'object' || data.entries === null) {
        return cache;
      }
      // a damaged entry is dropped on its own: it only costs a re-parse
      for (const [key, summary] of Object.entries(data.entries)) {
        if (isTestSummary(summary)) cache.set(key, summary);
      }
    } catch {
      // no cache yet, or a corrupt one: start empty
    }
    return cache;
  }

  /** Write the cache. Failing to write is never an error: the cache is only an optimization. */
  save(file: string): boolean {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ v: SUMMARY_VERSION, entries: Object.fromEntries(this.entries) }),
      );
      renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }
}
