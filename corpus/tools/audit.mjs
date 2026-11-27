#!/usr/bin/env node
// Re-checks the licence of every case in corpus/cases against the current rules, using the
// repository clones in corpus/.pool. Run it after changing the classifier.
//
//   node corpus/tools/audit.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultIo, git, nestedLicenseProblem, showBlob } from './harvest.mjs';
import {
  PERMISSIVE,
  classifyLicense,
  findLicenseFile,
  isRestrictedPath,
  repoDirName,
} from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Why a case must not be used, or null when it passes. */
export async function auditCase(io, repoDir, meta) {
  const names = (await git(io, repoDir, ['ls-tree', '--name-only', meta.commit])).stdout.split(
    '\n',
  );
  const file = findLicenseFile(names.filter(Boolean));
  if (!file) return 'no licence file';
  const text = await showBlob(io, repoDir, meta.commit, file);
  if (text === undefined) return `could not read ${file}`;
  const license = classifyLicense(text);
  if (!license || !PERMISSIVE.has(license)) return `licence is not permissive (${file})`;
  if (isRestrictedPath(meta.path)) return 'path is under a restricted directory';
  const nested = await nestedLicenseProblem(io, repoDir, meta.commit, meta.path);
  if (nested) return nested;
  return null;
}

async function main() {
  const casesDir = join(root, 'cases');
  const bad = [];
  for (const name of readdirSync(casesDir).sort()) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(casesDir, name, 'meta.json'), 'utf8'));
    } catch {
      continue;
    }
    const dir = join(root, '.pool', 'repos', repoDirName(meta.repo));
    let why;
    try {
      why = await auditCase(defaultIo, dir, meta);
    } catch (err) {
      why = `could not check: ${String(err.message ?? err).split('\n')[0]}`;
    }
    if (why) bad.push({ id: name, repo: meta.repo, why });
  }
  for (const b of bad) console.log(`${b.id}  ${b.repo}: ${b.why}`);
  console.log(`${bad.length} case(s) fail`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
