import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ParseError } from '../../src/errors.js';
import type { TestSummary } from '../../src/types.js';
import {
  SummaryCache,
  cacheKey,
  hashText,
  summarizeTestFile,
  SUMMARY_VERSION,
  isTestSummary,
} from '../../src/parse/index.js';

const SRC = `import { test, expect } from 'vitest';\ntest('a', () => { expect(1).toBe(1); });\n`;
const fake = (hash: string): TestSummary => ({
  hash,
  framework: 'unknown',
  imports: [],
  tests: [],
});

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), 'crashdummy-cache-')));

describe('summary cache', () => {
  test('an unchanged file is served from the cache, not parsed again', () => {
    const cache = new SummaryCache();
    const key = cacheKey(hashText(SRC), 'a.test.ts', {});
    cache.set(key, fake('from-cache'));
    const s = summarizeTestFile('a.test.ts', SRC, { cache, resolve: false });
    expect(s.hash).toBe('from-cache'); // a real parse would give the content hash
  });

  test('a miss parses and fills the cache; the next call is a hit', () => {
    const cache = new SummaryCache();
    const first = summarizeTestFile('a.test.ts', SRC, { cache, resolve: false });
    expect(cache.size).toBe(1);
    expect(first.tests).toHaveLength(1);
    expect(summarizeTestFile('b.test.ts', SRC, { cache, resolve: false })).toEqual(first);
    expect(cache.size).toBe(1);
  });

  test('changed content or options use a different key', () => {
    const k = (src: string, o = {}, path = 'a.test.ts') => cacheKey(hashText(src), path, o);
    expect(k(SRC)).not.toBe(k(SRC + '\n'));
    expect(k(SRC)).not.toBe(k(SRC, { assertFunctionNames: ['check*'] }));
    expect(k(SRC)).not.toBe(k(SRC, { matchers: { x: { strength: 3 } } }));
    expect(k(SRC, { assertFunctionNames: ['b', 'a'] })).toBe(
      k(SRC, { assertFunctionNames: ['a', 'b'] }),
    );
  });

  test('cached imports are resolved per call, because resolution depends on the file system', () => {
    const cache = new SummaryCache();
    const root = tmp();
    writeFileSync(join(root, 'cart.ts'), '');
    const src = `import './cart';\ntest('a', () => {});`;
    const a = summarizeTestFile('x.test.ts', src, { cache, resolve: { cwd: root } });
    const b = summarizeTestFile('x.test.ts', src, {
      cache,
      resolve: { cwd: root, exists: () => false },
    });
    expect(a.imports).toEqual(['cart.ts']);
    expect(b.imports).toEqual([]);
  });

  test('the same text is not reused across languages: TypeScript cached for .ts is a syntax error in .js', () => {
    const cache = new SummaryCache();
    const ts = `test('x', () => { const a: number = 1; expect(a).toBe(1); });`;
    expect(summarizeTestFile('a.test.ts', ts, { cache, resolve: false }).tests).toHaveLength(1);
    // a cached call must agree with an uncached one
    expect(() => summarizeTestFile('a.test.js', ts, { resolve: false })).toThrow(ParseError);
    expect(() => summarizeTestFile('a.test.js', ts, { cache, resolve: false })).toThrow(ParseError);
    expect(summarizeTestFile('b.test.ts', ts, { cache, resolve: false }).tests).toHaveLength(1);
  });

  test('evicts the least recently used entry past maxEntries', () => {
    const cache = new SummaryCache(2);
    cache.set('a', fake('a'));
    cache.set('b', fake('b'));
    cache.get('a'); // a is now the most recent
    cache.set('c', fake('c'));
    expect([cache.get('a')?.hash, cache.get('b')?.hash, cache.get('c')?.hash]).toEqual([
      'a',
      undefined,
      'c',
    ]);
  });

  describe('persistence', () => {
    test('save and load round-trip', () => {
      const file = join(tmp(), '.crashdummy', 'cache', 'summaries.json');
      const cache = new SummaryCache();
      summarizeTestFile('a.test.ts', SRC, { cache, resolve: false });
      expect(cache.save(file)).toBe(true);
      const loaded = SummaryCache.load(file);
      expect(loaded.size).toBe(1);
      expect(summarizeTestFile('a.test.ts', SRC, { cache: loaded, resolve: false })).toEqual(
        summarizeTestFile('a.test.ts', SRC, { resolve: false }),
      );
    });

    test.each([
      ['missing file', undefined],
      ['corrupt JSON', '{not json'],
      ['wrong version', JSON.stringify({ v: SUMMARY_VERSION + 1, entries: { a: fake('a') } })],
      ['wrong shape', JSON.stringify({ v: SUMMARY_VERSION, entries: null })],
    ])('%s gives an empty cache', (_label, content) => {
      const file = join(tmp(), 'summaries.json');
      if (content !== undefined) writeFileSync(file, content);
      expect(SummaryCache.load(file).size).toBe(0);
    });

    test('a damaged entry is dropped on its own, the rest still load', () => {
      const file = join(tmp(), 'summaries.json');
      const good = fake('good');
      writeFileSync(
        file,
        JSON.stringify({
          v: SUMMARY_VERSION,
          entries: {
            empty: {},
            noImports: { hash: 'h', framework: 'vitest', tests: [] },
            badFramework: { ...good, framework: 'mocha' },
            badTest: { ...good, tests: [{ id: 'x' }] },
            badMatcher: {
              ...good,
              tests: [
                {
                  id: 'x',
                  bodyHash: 'b',
                  loc: { line: 1, col: 1 },
                  matchers: [{ name: 'a', strength: 9, negated: false, subjectIsMock: false }],
                },
              ],
            },
            nullEntry: null,
            good,
          },
        }),
      );
      const cache = SummaryCache.load(file);
      expect(cache.size).toBe(1);
      expect(cache.get('good')).toEqual(good);
    });

    test('a damaged entry is a miss, not a crash', () => {
      const file = join(tmp(), 'summaries.json');
      const key = cacheKey(hashText(SRC), 'a.test.ts', {});
      writeFileSync(file, JSON.stringify({ v: SUMMARY_VERSION, entries: { [key]: {} } }));
      const cache = SummaryCache.load(file);
      const s = summarizeTestFile('a.test.ts', SRC, { cache, resolve: false });
      expect(s.tests).toHaveLength(1);
    });

    test('isTestSummary accepts what the parser produces', () => {
      const parsed = summarizeTestFile('a.test.ts', SRC + `test.skip('b', () => {});\n`, {
        resolve: false,
      });
      expect(isTestSummary(parsed)).toBe(true);
      expect(isTestSummary({ ...parsed, imports: [1] })).toBe(false);
      expect(isTestSummary(null)).toBe(false);
      expect(isTestSummary([])).toBe(false);
    });

    test('save never throws: an unwritable path just returns false', () => {
      const blocker = join(tmp(), 'blocker');
      writeFileSync(blocker, 'a regular file, so nothing can be created beneath it');
      expect(new SummaryCache().save(join(blocker, 'cache', 'summaries.json'))).toBe(false);
    });

    test('the file is plain JSON with a version', () => {
      const file = join(tmp(), 'summaries.json');
      const cache = new SummaryCache();
      cache.set('k', fake('h'));
      cache.save(file);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        v: SUMMARY_VERSION,
        entries: { k: fake('h') },
      });
    });
  });
});
