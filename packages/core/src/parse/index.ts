import { ParseError } from '../errors.js';
import type { TestSummary } from '../types.js';
import { SummaryCache, cacheKey } from './cache.js';
import { parseFile, type ParseDiagnostic, type ParsedFile } from './oxc.js';
import { resolveImports, type ResolveOptions } from './resolve.js';
import { createSummaryCollector, hashText, type SummaryOptions } from './summary.js';
import { walk, type Visitor } from './walk.js';

export interface AnalyzeOptions extends SummaryOptions {
  /**
   * Rule visitors to run on the same walk that builds the summary. Rules see only the adapter
   * types from `./ast.js`, never parser types.
   */
  visitors?: readonly Visitor[];
  /**
   * How to turn import specifiers into repo-relative paths. Defaults to the current directory.
   * Pass `false` to keep the specifiers exactly as written (for in-memory use).
   */
  resolve?: ResolveOptions | false;
  cache?: SummaryCache;
}

export interface Analysis {
  summary: TestSummary;
  /**
   * Syntax errors. oxc does not recover, so when this is not empty the summary is empty too and
   * must NOT be read as "the file has no tests". Report the file as unparseable instead.
   */
  errors: readonly ParseDiagnostic[];
  file: ParsedFile;
}

function finalize(raw: TestSummary, path: string, resolve: AnalyzeOptions['resolve']): TestSummary {
  if (resolve === false) return raw;
  return {
    ...raw,
    imports: resolveImports(raw.imports, path, resolve ?? { cwd: process.cwd() }),
  };
}

/**
 * Parse once and run the summary builder and any rule visitors on a single walk.
 * `path` is repo-relative and only used for resolution and messages.
 */
export function analyzeTestFile(
  path: string,
  source: string,
  options: AnalyzeOptions = {},
): Analysis {
  const file = parseFile(path, source);
  const collector = createSummaryCollector(options);
  walk(file.program, [collector.visitor, ...(options.visitors ?? [])], {
    path,
    source,
    lines: file.lines,
  });
  const raw = collector.finish(source);
  if (file.errors.length === 0) options.cache?.set(cacheKey(raw.hash, path, options), raw);
  return { summary: finalize(raw, path, options.resolve), errors: file.errors, file };
}

/**
 * A `TestSummary` for a file, using the cache when the same content was summarized before.
 * Use this for `before` text and baselines. Use `analyzeTestFile` when rules need the AST.
 * Throws `ParseError` when the file has syntax errors; failed parses are never cached.
 */
export function summarizeTestFile(
  path: string,
  source: string,
  options: Omit<AnalyzeOptions, 'visitors'> = {},
): TestSummary {
  const key = cacheKey(hashText(source), path, options);
  const hit = options.cache?.get(key);
  if (hit) return finalize(hit, path, options.resolve);
  const analysis = analyzeTestFile(path, source, options);
  if (analysis.errors.length > 0) throw new ParseError(path, analysis.errors);
  return analysis.summary;
}

export { SummaryCache, DEFAULT_CACHE_FILE, cacheKey, isTestSummary } from './cache.js';
export { resolveImport, resolveImports, type ResolveOptions } from './resolve.js';
export { hashNode, hashText, SUMMARY_VERSION, type SummaryOptions } from './summary.js';
export { walk, type Handler, type Visitor, type WalkContext } from './walk.js';
export {
  child,
  children,
  isFunction,
  isNode,
  memberPath,
  sourceText,
  staticNumber,
  staticString,
  str,
  unwrap,
  type AstNode,
} from './ast.js';
export type { ParsedFile, ParseDiagnostic } from './oxc.js';
