#!/usr/bin/env node
// Collects a pool of candidate AI-written test files from public repositories, for the labelled
// corpus (CD-6). A development tool: it is never shipped and never runs in CI.
//
//   node corpus/tools/harvest.mjs search [--since 2025-01-01] [--until 2026-11-30] [--max-pages 10]
//   node corpus/tools/harvest.mjs fetch  [--limit 500] [--per-repo 5]
//   node corpus/tools/harvest.mjs status
//
// Both stages resume where they stopped. Needs the `gh` CLI (commit search) and `git` (commits are
// fetched one at a time, without a working tree).
//
// What it downloads is untrusted. It is only ever read as bytes: never checked out, run, imported
// or passed to a shell. Git runs with hooks off and only the https protocol.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AGENTS,
  PERMISSIVE,
  candidateId,
  classifyLicense,
  contentHash,
  copyrightLine,
  detectFramework,
  findLicenseFile,
  isRestrictedPath,
  interestingChanges,
  interleave,
  monthWindows,
  parseNameStatus,
  repoDirName,
  sameLicenseText,
  searchKey,
  usableSource,
  verifyTrailer,
} from './lib.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const MAX = 20 * 1024 * 1024;

/** Where each external call goes. Tests replace these with fakes. */
export const defaultIo = {
  /** GitHub commit search. One page of results as parsed JSON. */
  async search(q, page) {
    const { stdout } = await run(
      'gh',
      [
        'api',
        '-X',
        'GET',
        'search/commits',
        '-f',
        `q=${q}`,
        '-f',
        'per_page=100',
        '-f',
        `page=${page}`,
        '-f',
        'sort=committer-date',
      ],
      { maxBuffer: MAX },
    );
    return JSON.parse(stdout);
  },
  remote: (repo) => `https://github.com/${repo}.git`,
  /** Extra `-c` settings; tests add `protocol.file.allow=always` to use a local repository. */
  gitConfig: ['protocol.allow=never', 'protocol.https.allow=always'],
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export class Pool {
  constructor(dir) {
    this.dir = resolve(dir);
    this.commits = join(this.dir, 'commits.jsonl');
    this.candidates = join(this.dir, 'candidates.jsonl');
    this.searchDone = join(this.dir, 'search-done.json');
    this.fetched = join(this.dir, 'fetched.json');
    mkdirSync(join(this.dir, 'files'), { recursive: true });
    mkdirSync(join(this.dir, 'repos'), { recursive: true });
  }
  readJson(file, fallback) {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  }
  readLines(file) {
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  }
  append(file, value) {
    appendFileSync(file, `${JSON.stringify(value)}\n`);
  }
}

/** Stage 1: commit search. Every hit is verified: the trailer has to be in the message. */
export async function search(pool, options, io = defaultIo) {
  const done = new Set(pool.readJson(pool.searchDone, []));
  const known = new Set(pool.readLines(pool.commits).map((c) => `${c.repo}@${c.sha}`));
  const windows = monthWindows(options.since, options.until);
  const gap = 60000 / 25; // GitHub allows 30 searches a minute: stay under it
  let requests = 0;
  let added = 0;
  let rejected = 0;

  for (const agent of AGENTS) {
    for (const query of agent.queries) {
      for (const window of windows) {
        // a window whose last page was reached is finished: do not ask for the page after it
        const finished = searchKey(query, window, 'end');
        if (done.has(finished)) continue;
        for (let page = 1; page <= options.maxPages; page++) {
          const key = searchKey(query, window, page);
          if (done.has(key)) continue;
          const q = `${query} test committer-date:${window[0]}..${window[1]} is:public`;
          let result;
          for (let attempt = 0; ; attempt++) {
            try {
              await io.sleep(requests === 0 ? 0 : gap);
              requests++;
              result = await io.search(q, page);
              break;
            } catch (error) {
              if (attempt >= 3) throw error;
              await io.sleep(65000); // rate limited, most likely
            }
          }
          for (const item of result.items ?? []) {
            const repo = item.repository?.full_name;
            const message = item.commit?.message ?? '';
            const trailer = verifyTrailer(message);
            if (!repo || !trailer || item.repository.private) {
              rejected++;
              continue;
            }
            const id = `${repo}@${item.sha}`;
            if (known.has(id)) continue;
            known.add(id);
            added++;
            pool.append(pool.commits, {
              repo,
              sha: item.sha,
              trailer,
              fork: item.repository.fork === true,
              date: item.commit?.committer?.date ?? null,
              subject: message.split('\n')[0].slice(0, 200),
            });
          }
          done.add(key);
          writeFileSync(pool.searchDone, JSON.stringify([...done]));
          if ((result.items?.length ?? 0) < 100) {
            done.add(finished); // last page of this window
            writeFileSync(pool.searchDone, JSON.stringify([...done]));
            break;
          }
        }
      }
    }
  }
  return { requests, added, rejected };
}

export const git = (io, dir, args, extra = {}) =>
  run(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      ...io.gitConfig.flatMap((c) => ['-c', c]),
      ...args,
    ],
    {
      cwd: dir,
      maxBuffer: MAX,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
      ...extra,
    },
  );

export const showBlob = async (io, dir, rev, path) => {
  try {
    return (await git(io, dir, ['show', `${rev}:${path}`])).stdout;
  } catch {
    return undefined;
  }
};

/** The repository's own licence file at a revision, or null. */
export async function rootLicense(io, dir, rev) {
  const names = (await git(io, dir, ['ls-tree', '--name-only', rev])).stdout
    .split('\n')
    .filter(Boolean);
  const file = findLicenseFile(names);
  if (!file) return null;
  const text = await showBlob(io, dir, rev, file);
  return text === undefined ? null : { file, text };
}

/**
 * Licence files in the directories above a file, below the repository root. A package in a
 * monorepo often carries its own copy of the same licence; one that is not permissive, that
 * cannot be read, or that is a different licence from the root's means the file is not covered
 * by what NOTICE.md records for the repository. The same text with another copyright line is
 * fine. Reads trees, and the licence files themselves. Returns null when nothing is wrong, else
 * the reason.
 *
 * `rootText` is the root licence at `sha`; it is read when not given.
 */
export async function nestedLicenseProblem(io, dir, sha, path, rootText) {
  const parts = path.split('/').slice(0, -1);
  let root = rootText;
  for (let i = parts.length; i >= 1; i--) {
    const sub = parts.slice(0, i).join('/');
    const listed = (await git(io, dir, ['ls-tree', '--name-only', sha, `${sub}/`])).stdout
      .split('\n')
      .filter(Boolean)
      .map((n) => n.slice(sub.length + 1));
    const file = findLicenseFile(listed);
    if (!file) continue;
    const text = await showBlob(io, dir, sha, `${sub}/${file}`);
    const license = text === undefined ? null : classifyLicense(text);
    if (!license || !PERMISSIVE.has(license)) return `${sub}/${file} is not permissive`;
    root ??= (await rootLicense(io, dir, sha))?.text;
    if (root === undefined || !sameLicenseText(root, text)) {
      return `${sub}/${file} differs from the root licence`;
    }
  }
  return null;
}

/**
 * Whether the file at `path` in revision `rev` may be copied: permissive root licence, outside
 * restricted directories, and no differing licence on the way. With `reference` (the root
 * licence of the pinned commit) the root licence at `rev` must also be the same text, so one
 * copy of the licence covers both sides of a change. Null when fine, else the reason.
 */
export async function sourceLicenseProblem(io, dir, rev, path, reference) {
  const root = await rootLicense(io, dir, rev);
  if (!root) return 'no licence file';
  const license = classifyLicense(root.text);
  if (!license || !PERMISSIVE.has(license)) return `licence is not permissive (${root.file})`;
  if (reference !== undefined && !sameLicenseText(reference, root.text)) {
    return `root licence (${root.file}) differs from the pinned commit's`;
  }
  if (isRestrictedPath(path)) return 'path is under a restricted directory';
  return nestedLicenseProblem(io, dir, rev, path, root.text);
}

/** A file of a revision as bytes, untouched by any text decoding. */
export async function showBlobBytes(io, dir, rev, path) {
  return (await git(io, dir, ['show', `${rev}:${path}`], { encoding: 'buffer' })).stdout;
}

/** Stage 2: fetch each verified commit, check the licence, and keep its test files. */
export async function fetchCommits(pool, options, io = defaultIo) {
  const state = pool.readJson(pool.fetched, {});
  const seenContent = new Set(pool.readLines(pool.candidates).map((c) => c.contentHash));
  const perRepo = new Map();
  for (const c of pool.readLines(pool.candidates))
    perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
  const stats = { fetched: 0, kept: 0, skipped: {} };
  const skip = (why) => (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);
  let total = pool.readLines(pool.candidates).length;

  for (const commit of interleave(pool.readLines(pool.commits))) {
    if (total >= options.limit) break;
    const key = `${commit.repo}@${commit.sha}`;
    if (state[key]) continue;
    const finish = (result) => {
      state[key] = result;
      writeFileSync(pool.fetched, JSON.stringify(state));
    };
    if (commit.fork) {
      finish('fork');
      skip('fork');
      continue;
    }
    if ((perRepo.get(commit.repo) ?? 0) >= options.perRepo) {
      skip('repo-cap'); // not recorded: a later run with a higher cap may take it
      continue;
    }

    let dir;
    try {
      dir = join(pool.dir, 'repos', repoDirName(commit.repo));
    } catch {
      finish('bad-name');
      skip('bad-name');
      continue;
    }
    try {
      if (!existsSync(join(dir, 'HEAD'))) {
        mkdirSync(dir, { recursive: true });
        await git(io, dir, ['init', '-q', '--bare']);
        await git(io, dir, ['remote', 'add', 'origin', io.remote(commit.repo)]);
      }
      await git(io, dir, ['fetch', '-q', '--depth=2', '--filter=blob:none', 'origin', commit.sha]);
    } catch {
      finish('fetch-failed');
      skip('fetch-failed');
      continue;
    }
    stats.fetched++;

    const parents = (await git(io, dir, ['rev-list', '--parents', '-n', '1', commit.sha])).stdout
      .trim()
      .split(' ')
      .slice(1);
    if (parents.length > 1) {
      finish('merge');
      skip('merge');
      continue;
    }

    // licence first: it decides whether anything from this commit may be copied
    const root = (await git(io, dir, ['ls-tree', '--name-only', commit.sha])).stdout
      .split('\n')
      .filter(Boolean);
    const licenseFile = findLicenseFile(root);
    const licenseText = licenseFile ? await showBlob(io, dir, commit.sha, licenseFile) : undefined;
    const license = licenseText ? classifyLicense(licenseText) : null;
    if (!license || !PERMISSIVE.has(license)) {
      finish(`license:${license ?? (licenseFile ? 'other' : 'none')}`);
      skip(`license:${license ?? (licenseFile ? 'other' : 'none')}`);
      continue;
    }

    const names = (
      await git(io, dir, [
        'diff-tree',
        '-z',
        '--root',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-M',
        commit.sha,
      ])
    ).stdout;
    // code under ee/, enterprise/ and the like is licensed apart from the rest of the repository
    const changes = interestingChanges(parseNameStatus(names)).filter(
      (c) => !isRestrictedPath(c.path),
    );
    if (changes.length === 0) {
      finish('no-test-files');
      skip('no-test-files');
      continue;
    }

    let kept = 0;
    let capped = false;
    for (const change of changes) {
      if ((perRepo.get(commit.repo) ?? 0) >= options.perRepo || total >= options.limit) {
        capped = true; // files are left over: keep the commit pending so a higher cap can replay it
        break;
      }
      if (await nestedLicenseProblem(io, dir, commit.sha, change.path, licenseText)) {
        skip('nested-license');
        continue;
      }
      const after = await showBlob(io, dir, commit.sha, change.path);
      if (after === undefined || !usableSource(after)) {
        skip('unusable');
        continue;
      }
      const hash = contentHash(after);
      if (seenContent.has(hash)) {
        skip('duplicate');
        continue;
      }
      let before;
      if (change.status !== 'A' && parents[0]) {
        // the old version is a different revision and maybe a different path: it must be
        // covered by the same permissive licence, or it is not copied
        const oldPath = change.oldPath ?? change.path;
        if (await sourceLicenseProblem(io, dir, parents[0], oldPath, licenseText)) {
          skip('before-license');
        } else {
          before = await showBlob(io, dir, parents[0], oldPath);
          if (before !== undefined && !usableSource(before, { minLines: 0, maxLines: 4000 }))
            before = undefined;
        }
      }
      const id = candidateId(commit.repo, commit.sha, change.path);
      const out = join(pool.dir, 'files', id);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'after.txt'), after);
      if (before !== undefined) writeFileSync(join(out, 'before.txt'), before);
      pool.append(pool.candidates, {
        id,
        repo: commit.repo,
        sha: commit.sha,
        parent: parents[0] ?? null,
        path: change.path,
        oldPath: change.oldPath ?? null,
        status: change.status,
        trailer: commit.trailer,
        date: commit.date,
        license,
        licenseFile,
        copyright: copyrightLine(licenseText),
        framework: detectFramework(after),
        lines: after.split('\n').length,
        hasBefore: before !== undefined,
        contentHash: hash,
      });
      seenContent.add(hash);
      perRepo.set(commit.repo, (perRepo.get(commit.repo) ?? 0) + 1);
      total++;
      kept++;
      stats.kept++;
    }
    if (!capped) finish(kept > 0 ? 'kept' : 'nothing-usable');
  }
  return stats;
}

/** What the pool holds. */
export function status(pool) {
  const commits = pool.readLines(pool.commits);
  const candidates = pool.readLines(pool.candidates);
  const count = (items, key) =>
    Object.entries(items.reduce((m, i) => ((m[key(i)] = (m[key(i)] ?? 0) + 1), m), {})).sort(
      (a, b) => b[1] - a[1],
    );
  return {
    commits: commits.length,
    commitsByAgent: count(commits, (c) => c.trailer),
    fetchOutcomes: count(Object.values(pool.readJson(pool.fetched, {})), (v) => v),
    candidates: candidates.length,
    repos: new Set(candidates.map((c) => c.repo)).size,
    byFramework: count(candidates, (c) => c.framework),
    byLicense: count(candidates, (c) => c.license),
    byAgent: count(candidates, (c) => c.trailer),
    withBefore: candidates.filter((c) => c.hasBefore).length,
  };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

async function main(argv) {
  const [command] = argv;
  const pool = new Pool(arg(argv, 'pool', join(here, '..', '.pool')));
  if (command === 'search') {
    const today = new Date().toISOString().slice(0, 10);
    const result = await search(pool, {
      since: arg(argv, 'since', '2025-02-01'),
      until: arg(argv, 'until', today),
      maxPages: Number(arg(argv, 'max-pages', '10')),
    });
    console.log(result);
  } else if (command === 'fetch') {
    const result = await fetchCommits(pool, {
      limit: Number(arg(argv, 'limit', '600')),
      perRepo: Number(arg(argv, 'per-repo', '5')),
    });
    console.log(result);
  } else if (command === 'status') {
    console.log(JSON.stringify(status(pool), null, 2));
  } else {
    console.error('usage: harvest.mjs search|fetch|status [options]');
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
