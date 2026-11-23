import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ChangedFile, ChangeSource, CollectOptions } from '../types.js';
import { createTestFileMatcher } from './testfiles.js';

/**
 * Split a file list from `--files` or stdin. Newline separated, or NUL separated when the input
 * contains a NUL (for `find -print0` and `git ls-files -z`). Blank lines are ignored.
 */
export function parseFileList(input: string): string[] {
  const delimiter = input.includes('\0') ? '\0' : /\r?\n/;
  return input
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a file list from a stream such as `process.stdin`. */
export async function readFileListFromStream(
  stream: AsyncIterable<Buffer | string>,
): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  return parseFileList(chunks.join(''));
}

function toRepoPath(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : relative(cwd, resolve(cwd, file));
  return rel.split(sep).join('/');
}

/**
 * Explicit file list, no git. Every file that exists is reported as `added` with no `before`
 * (there is nothing to diff against yet; a snapshot can supply it later). A listed file that no
 * longer exists is reported as `deleted`.
 */
export const filesSource: ChangeSource = {
  name: 'files',

  async detect(_cwd, opts) {
    return (opts?.files?.length ?? 0) > 0;
  },

  async collect(opts: CollectOptions): Promise<ChangedFile[]> {
    const isTest = createTestFileMatcher(opts.testGlobs);
    const all = opts.scope === 'all';
    const seen = new Set<string>();
    const out: ChangedFile[] = [];

    for (const file of opts.files ?? []) {
      const path = toRepoPath(opts.cwd, file);
      if (seen.has(path)) continue;
      seen.add(path);
      if (!all && !isTest(path)) continue;

      const abs = resolve(opts.cwd, file);
      const info = await stat(abs).catch(() => undefined);
      if (info === undefined) {
        out.push({ path, kind: 'deleted' });
      } else if (info.isFile()) {
        out.push({ path, kind: 'added', after: await readFile(abs, 'utf8') });
      }
    }
    return out;
  },
};
