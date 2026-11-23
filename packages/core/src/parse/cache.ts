import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TestSummary } from '../types.js';
import { SUMMARY_VERSION, hashText, type SummaryOptions } from './summary.js';

/** Where the plan keeps the persisted cache, relative to the repo root. */
export const DEFAULT_CACHE_FILE = '.crashdummy/cache/summaries.json';

/** Everything besides the file content that changes what a summary contains. */
export function cacheKey(contentHash: string, options: SummaryOptions): string {
  const fingerprint = hashText(
    JSON.stringify([
      SUMMARY_VERSION,
      [...(options.assertFunctionNames ?? [])].sort(),
      options.matchers ?? {},
    ]),
  );
  return `${fingerprint}:${contentHash}`;
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
      for (const [key, summary] of Object.entries(data.entries)) cache.set(key, summary);
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
