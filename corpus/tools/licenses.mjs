// Bundles the licence texts of the repositories the corpus cases come from. Apache-2.0 section
// 4(a) and 4(d), MIT and BSD all require that a recipient gets the licence text (and, for Apache,
// the NOTICE file) along with the files, so `corpus/licenses/<owner>__<name>/` holds the files
// exactly as they are at the pinned commit. select.mjs and prune.mjs call this, so a new run
// keeps them in step with the cases.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, rootLicense, showBlobBytes } from './harvest.mjs';
import { repoDirName } from './lib.mjs';

/** A root-level NOTICE file, which Apache-2.0 section 4(d) asks to be passed on. */
const NOTICE_FILE = /^NOTICE(?:\.(?:md|markdown|txt))?$/i;

/**
 * Reads, for every distinct repository and commit among `entries` (`{ repo, commit | sha,
 * licenseFile }`), its licence file and root NOTICE file as bytes. Nothing is written; it throws
 * when a licence cannot be read, so a caller can stop before it changes anything.
 *
 * Returns `[{ repo, dir, files: [{ name, bytes }] }]`. When two commits of one repository carry
 * different bytes under the same name, the later one is stored as `<name>.<first 12 of sha>`.
 */
export async function collectLicenseFiles(io, reposDir, entries) {
  const byRepo = new Map();
  for (const e of entries) {
    const commit = e.commit ?? e.sha;
    const list = byRepo.get(e.repo) ?? new Map();
    list.set(commit, e.licenseFile);
    byRepo.set(e.repo, list);
  }
  const plan = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const name = repoDirName(repo);
    const clone = join(reposDir, name);
    const files = [];
    for (const [commit, licenseFile] of [...byRepo.get(repo)].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const found = licenseFile ?? (await rootLicense(io, clone, commit))?.file;
      if (!found) throw new Error(`${repo}@${commit}: no licence file`);
      const names = (await git(io, clone, ['ls-tree', '--name-only', commit])).stdout
        .split('\n')
        .filter(Boolean);
      const wanted = [found, ...names.filter((n) => NOTICE_FILE.test(n))];
      for (const file of wanted) {
        let bytes;
        try {
          bytes = await showBlobBytes(io, clone, commit, file);
        } catch (err) {
          throw new Error(
            `${repo}@${commit}: cannot read ${file}: ${String(err.message).split('\n')[0]}`,
          );
        }
        const same = files.find((f) => f.source === file && f.bytes.equals(bytes));
        if (same) continue;
        const taken = files.some((f) => f.name === file);
        files.push({ name: taken ? `${file}.${commit.slice(0, 12)}` : file, source: file, bytes });
      }
    }
    plan.push({
      repo,
      dir: name,
      files: files.map(({ name: n, bytes }) => ({ name: n, bytes })),
    });
  }
  return plan;
}

/** Replaces `<out>/licenses` with the planned files. */
export function writeLicenseFiles(plan, out) {
  const base = join(out, 'licenses');
  rmSync(base, { recursive: true, force: true });
  for (const entry of plan) {
    const dir = join(base, entry.dir);
    mkdirSync(dir, { recursive: true });
    for (const f of entry.files) writeFileSync(join(dir, f.name), f.bytes);
  }
}

/** `licenses/<dir>/<file>` paths for NOTICE.md, by repository. */
export function licenseDocs(plan) {
  return new Map(plan.map((e) => [e.repo, e.files.map((f) => `licenses/${e.dir}/${f.name}`)]));
}

/** Collects and writes in one go. Returns what notice() needs to reference the files. */
export async function copyLicenseFiles(io, reposDir, entries, out) {
  const plan = await collectLicenseFiles(io, reposDir, entries);
  writeLicenseFiles(plan, out);
  return licenseDocs(plan);
}
