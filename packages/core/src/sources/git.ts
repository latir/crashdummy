import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, ChangeSource, CollectOptions, LineRange } from '../types.js';
import { SourceError } from './errors.js';
import { createTestFileMatcher } from './testfiles.js';

const execFileAsync = promisify(execFile);

/** Tried in order when no `--base` is given. `origin/HEAD` is the plan's default. */
const DEFAULT_BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
      env: GIT_ENV,
    });
    return stdout;
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr?.trim();
    throw new SourceError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`, { cause });
  }
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(cwd, args);
  } catch {
    return undefined;
  }
}

/** The commit to diff against: the merge-base of the base ref and HEAD. */
export async function resolveBase(cwd: string, base?: string): Promise<string> {
  const candidates = base === undefined ? DEFAULT_BASE_CANDIDATES : [base];
  for (const ref of candidates) {
    const exists = await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (exists === undefined) {
      if (base !== undefined) {
        throw new SourceError(`base '${base}' is not a known commit or ref. Check --base.`);
      }
      continue;
    }
    const mergeBase = await tryGit(cwd, ['merge-base', ref, 'HEAD']);
    if (mergeBase === undefined) {
      throw new SourceError(
        `no common ancestor between '${ref}' and HEAD. In CI, fetch full history (for example fetch-depth: 0).`,
      );
    }
    return mergeBase.trim();
  }
  throw new SourceError(
    `could not find a base branch (tried ${DEFAULT_BASE_CANDIDATES.join(', ')}). Pass --base <ref>.`,
  );
}

const C_ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  '"': 34,
  '\\': 92,
};

/** git quotes paths with special characters as "..." with C escapes and octal bytes. */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = inner[i + 1]!;
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface DiffEntry {
  /** git status letter: A, M, D, R, C or T. */
  status: string;
  path: string;
  /** For renames and copies. */
  oldPath?: string;
  /** True for submodules, which have no file content. */
  gitlink: boolean;
  /** Added or changed lines in the new file. */
  lines: LineRange[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --patch-with-raw --unified=0` output. The raw lines come first, one per file;
 * the patch then has exactly one `diff --git` section per raw line, in the same order, so hunks
 * are matched to files by position and never by parsing paths out of the patch.
 */
export function parseDiff(output: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let current = -1;
  for (const line of output.split('\n')) {
    if (current === -1 && line.startsWith(':')) {
      const [head = '', first = '', second] = line.split('\t');
      const fields = head.slice(1).split(' ');
      const status = (fields[4] ?? '?').charAt(0);
      const path = unquotePath(second ?? first);
      const entry: DiffEntry = {
        status,
        path,
        gitlink: fields[0] === '160000' || fields[1] === '160000',
        lines: [],
      };
      if (second !== undefined) entry.oldPath = unquotePath(first);
      entries.push(entry);
    } else if (line.startsWith('diff --git ')) {
      current++;
    } else if (current >= 0) {
      const m = HUNK.exec(line);
      const entry = entries[current];
      if (m && entry) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        // A count of 0 is a pure deletion: no lines in the new file changed.
        if (count > 0) entry.lines.push({ start, end: start + count - 1 });
      }
    }
  }
  return entries;
}

/** Read many objects with one `git cat-file --batch`. Missing objects come back `undefined`. */
export async function readObjects(cwd: string, specs: string[]): Promise<(string | undefined)[]> {
  if (specs.length === 0) return [];
  const stdout = await new Promise<Buffer>((resolveP, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd,
      env: GIT_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveP(Buffer.concat(out));
      else {
        reject(
          new SourceError(`git cat-file failed: ${Buffer.concat(err).toString('utf8').trim()}`),
        );
      }
    });
    child.stdin.end(specs.map((s) => `${s}\n`).join(''));
  });

  const results: (string | undefined)[] = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = stdout.indexOf(0x0a, pos);
    if (nl === -1) throw new SourceError('unexpected end of git cat-file output');
    const header = stdout.toString('utf8', pos, nl);
    pos = nl + 1;
    const found = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(header);
    if (!found) {
      results.push(undefined); // "<spec> missing"
      continue;
    }
    const size = Number(found[2]);
    results.push(found[1] === 'blob' ? stdout.toString('utf8', pos, pos + size) : undefined);
    pos += size + 1;
  }
  return results;
}

/** Whether `cwd` is inside a git work tree. Walks up looking for `.git`; spawns nothing. */
function insideGitRepo(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

interface Planned {
  kind: ChangedFile['kind'];
  path: string;
  previousPath?: string;
  lines: LineRange[];
}

/**
 * Changes between the merge-base of the base ref and HEAD. Uncommitted changes are not included.
 *
 * Paths are repo-relative. A rename between a test path and a non-test path is reported from the
 * test file's side: test to non-test is a `deleted` test, non-test to test is an `added` test.
 * Paths containing a newline cannot be read through `cat-file --batch` and are skipped.
 */
export const gitSource: ChangeSource = {
  name: 'git',

  async detect(cwd) {
    return insideGitRepo(cwd);
  },

  async collect(opts: CollectOptions): Promise<ChangedFile[]> {
    const { cwd } = opts;
    const isTest = createTestFileMatcher(opts.testGlobs);
    const all = opts.scope === 'all';

    const baseSha = await resolveBase(cwd, opts.base);
    const diff = await runGit(cwd, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--patch-with-raw',
      '-M',
      '--unified=0',
      baseSha,
      'HEAD',
    ]);

    const planned: Planned[] = [];
    for (const e of parseDiff(diff)) {
      if (e.gitlink || e.path.includes('\n') || e.oldPath?.includes('\n')) continue;
      if (e.status === 'R' && e.oldPath !== undefined) {
        const newIsTest = isTest(e.path);
        const oldIsTest = isTest(e.oldPath);
        if (!all && !newIsTest && !oldIsTest) continue;
        if (!all && oldIsTest && !newIsTest) {
          planned.push({ kind: 'deleted', path: e.oldPath, lines: [] });
        } else if (!all && !oldIsTest && newIsTest) {
          planned.push({ kind: 'added', path: e.path, lines: e.lines });
        } else {
          planned.push({ kind: 'renamed', path: e.path, previousPath: e.oldPath, lines: e.lines });
        }
        continue;
      }
      if (!all && !isTest(e.path)) continue;
      const kind =
        e.status === 'A' || e.status === 'C' ? 'added' : e.status === 'D' ? 'deleted' : 'modified';
      planned.push({ kind, path: e.path, lines: e.lines });
    }

    // One batch for every old and new text.
    const specs: string[] = [];
    const slots = planned.map((p) => {
      const slot: { before?: number; after?: number } = {};
      if (p.kind !== 'added')
        slot.before = specs.push(`${baseSha}:${p.previousPath ?? p.path}`) - 1;
      if (p.kind !== 'deleted') slot.after = specs.push(`HEAD:${p.path}`) - 1;
      return slot;
    });
    const texts = await readObjects(cwd, specs);

    return planned.map((p, i): ChangedFile => {
      const slot = slots[i]!;
      const file: ChangedFile = { path: p.path, kind: p.kind };
      if (p.previousPath !== undefined) file.previousPath = p.previousPath;
      const before = slot.before === undefined ? undefined : texts[slot.before];
      const after = slot.after === undefined ? undefined : texts[slot.after];
      if (before !== undefined) file.before = before;
      if (after !== undefined) file.after = after;
      if (p.kind !== 'deleted') file.changedLines = p.lines;
      return file;
    });
  },
};
