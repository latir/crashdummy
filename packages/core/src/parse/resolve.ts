import { existsSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve as resolvePath, sep } from 'node:path';

export interface ResolveOptions {
  /** Repo root. Resolved paths are relative to it. */
  cwd: string;
  /** tsconfig `compilerOptions.paths`. Each pattern may contain one `*`. */
  paths?: Readonly<Record<string, readonly string[]>>;
  /** tsconfig `compilerOptions.baseUrl`, relative to `cwd`. Default is `cwd`. */
  baseUrl?: string;
  /** For tests. Receives an absolute path. */
  exists?: (absolutePath: string) => boolean;
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// ESM TypeScript writes './x.js' for './x.ts'.
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Try `base` as a file, then with extensions, then as a directory index. Repo-relative paths. */
function probe(base: string, opts: ResolveOptions): string | undefined {
  const exists = opts.exists ?? existsSync;
  const abs = (p: string): string => resolvePath(opts.cwd, p);
  const isFile = (p: string): boolean => /\.[cm]?[jt]sx?$/.test(p) && exists(abs(p));

  if (isFile(base)) return base;
  const ext = /\.[cm]?jsx?$/.exec(base)?.[0];
  if (ext) {
    for (const alt of JS_TO_TS[ext] ?? []) {
      const candidate = base.slice(0, -ext.length) + alt;
      if (exists(abs(candidate))) return candidate;
    }
  }
  for (const e of EXTENSIONS) if (exists(abs(base + e))) return base + e;
  for (const e of EXTENSIONS) if (exists(abs(`${base}/index${e}`))) return `${base}/index${e}`;
  return undefined;
}

function matchPattern(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === spec ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length) return undefined;
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return undefined;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

/**
 * Resolve one import specifier from `fromFile` (repo-relative) to a repo-relative path, or
 * undefined. Relative paths and tsconfig `paths` only. Packages from `node_modules` are left
 * unresolved on purpose: only code in this repo can be "under test".
 */
export function resolveImport(
  specifier: string,
  fromFile: string,
  opts: ResolveOptions,
): string | undefined {
  if (specifier.startsWith('.')) {
    const joined = posix.normalize(posix.join(posix.dirname(toPosix(fromFile)), specifier));
    return joined.startsWith('..') ? undefined : probe(joined, opts);
  }

  // Like TypeScript: an exact pattern wins, otherwise the wildcard with the longest prefix, and
  // only that pattern's targets are tried.
  let best: { captured: string; targets: readonly string[]; prefix: number } | undefined;
  for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
    const captured = matchPattern(pattern, specifier);
    if (captured === undefined) continue;
    const prefix = pattern.includes('*') ? pattern.indexOf('*') : Infinity;
    if (!best || prefix > best.prefix) best = { captured, targets, prefix };
  }
  if (!best) return undefined;

  const baseUrl = toPosix(
    isAbsolute(opts.baseUrl ?? '.') ? relative(opts.cwd, opts.baseUrl!) : (opts.baseUrl ?? '.'),
  );
  for (const target of best.targets) {
    const mapped = posix.normalize(posix.join(baseUrl, target.replace('*', best.captured)));
    // Only code in this repo can be under test: never follow a mapping out of it.
    if (mapped.startsWith('..') || isAbsolute(mapped)) continue;
    const hit = probe(mapped, opts);
    if (hit) return hit;
  }
  return undefined;
}

/** Resolve a list of specifiers, dropping anything unresolved and removing duplicates. */
export function resolveImports(
  specifiers: readonly string[],
  fromFile: string,
  opts: ResolveOptions,
): string[] {
  const out: string[] = [];
  for (const spec of specifiers) {
    const hit = resolveImport(spec, fromFile, opts);
    if (hit !== undefined && !out.includes(hit)) out.push(hit);
  }
  return out;
}
