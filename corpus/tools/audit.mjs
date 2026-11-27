#!/usr/bin/env node
// Re-checks the licence of every case in corpus/cases against the current rules, using the
// repository clones in corpus/.pool. Run it after changing the classifier.
//
//   node corpus/tools/audit.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultIo, git, rootLicense, sourceLicenseProblem } from './harvest.mjs';
import { parseNameStatus, repoDirName } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Why a case must not be used, or null when it passes. Both sides are checked: the new file at
 * the pinned commit, and, for a case with a before file, the old file at the parent commit and
 * its old path (a rename can come out of a restricted directory, and a licence can change
 * between the two commits).
 */
export async function auditCase(io, repoDir, meta) {
  const after = await sourceLicenseProblem(io, repoDir, meta.commit, meta.path);
  if (after) return after;
  if (meta.hasBefore === true) {
    const before = await beforeProblem(io, repoDir, meta);
    if (before) return `before: ${before}`;
  }
  return null;
}

async function beforeProblem(io, repoDir, meta) {
  const parents = (await git(io, repoDir, ['rev-list', '--parents', '-n', '1', meta.commit])).stdout
    .trim()
    .split(' ')
    .slice(1);
  if (parents.length !== 1) return 'cannot find the parent commit';
  const diff = (
    await git(io, repoDir, [
      'diff-tree',
      '-z',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-M',
      meta.commit,
    ])
  ).stdout;
  const change = parseNameStatus(diff).find((c) => c.path === meta.path);
  const oldPath = change?.oldPath ?? meta.path;
  const reference = (await rootLicense(io, repoDir, meta.commit))?.text;
  if (reference === undefined) return 'no licence file';
  return sourceLicenseProblem(io, repoDir, parents[0], oldPath, reference);
}

/** Audits every case folder in `casesDir`. A folder that cannot be read counts as a failure. */
export async function auditCases(io, casesDir, poolReposDir) {
  const bad = [];
  for (const name of readdirSync(casesDir).sort()) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(casesDir, name, 'meta.json'), 'utf8'));
      if (typeof meta?.repo !== 'string' || typeof meta.commit !== 'string') {
        throw new Error('meta.json has no repo or commit');
      }
    } catch (err) {
      bad.push({ id: name, repo: '?', why: `meta.json is missing or invalid: ${firstLine(err)}` });
      continue;
    }
    let why;
    try {
      const dir = join(poolReposDir, repoDirName(meta.repo));
      if (!existsSync(dir)) throw new Error('no clone of the repository in the pool');
      why = await auditCase(io, dir, meta);
    } catch (err) {
      why = `could not check: ${firstLine(err)}`;
    }
    if (why) bad.push({ id: name, repo: meta.repo, why });
  }
  return bad;
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

async function main() {
  const bad = await auditCases(defaultIo, join(root, 'cases'), join(root, '.pool', 'repos'));
  for (const b of bad) console.log(`${b.id}  ${b.repo}: ${b.why}`);
  console.log(`${bad.length} case(s) fail`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
