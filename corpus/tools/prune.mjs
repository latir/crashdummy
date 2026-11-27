#!/usr/bin/env node
// Removes cases that fail the licence audit, and rewrites what depends on the case list:
// selection.json (with a `removed` record), NOTICE.md. Regenerate label-data.json afterwards.
//
//   node corpus/tools/prune.mjs          # audit and remove
//   node corpus/tools/prune.mjs --dry    # audit only

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCase } from './audit.mjs';
import { defaultIo } from './harvest.mjs';
import { repoDirName } from './lib.mjs';
import { collectLicenseFiles, licenseDocs, writeLicenseFiles } from './licenses.mjs';
import { notice } from './select.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function dropFromSelection(selection, removed) {
  const gone = new Set(removed.map((r) => r.id));
  return {
    ...selection,
    random: selection.random.filter((id) => !gone.has(id)),
    targeted: selection.targeted.filter((id) => !gone.has(id)),
    removed: [...(selection.removed ?? []), ...removed],
  };
}

/** Reads and checks everything the pruning depends on. Throws before anything is changed. */
function loadSelection(path) {
  const selection = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['random', 'targeted']) {
    if (!Array.isArray(selection?.[key])) throw new Error(`${path}: "${key}" is not a list`);
  }
  if (selection.removed !== undefined && !Array.isArray(selection.removed)) {
    throw new Error(`${path}: "removed" is not a list`);
  }
  return selection;
}

/**
 * Audits every case and removes the ones that fail. All input is loaded, parsed and audited, and
 * every output is computed, before the first file is deleted or written: a bad selection.json or
 * an unreadable licence leaves the corpus as it was.
 *
 * `io.audit(meta, id)` and `io.collectLicenses(entries)` can be replaced in tests.
 */
export async function prune({ root: base = root, dry = false } = {}, io = {}) {
  const casesDir = join(base, 'cases');
  const reposDir = join(base, '.pool', 'repos');
  const audit =
    io.audit ?? ((meta) => auditCase(defaultIo, join(reposDir, repoDirName(meta.repo)), meta));
  const collect =
    io.collectLicenses ?? ((entries) => collectLicenseFiles(defaultIo, reposDir, entries));

  const selPath = join(base, 'selection.json');
  const selection = loadSelection(selPath);
  const removed = [];
  const metas = [];
  for (const id of readdirSync(casesDir).sort()) {
    const meta = JSON.parse(readFileSync(join(casesDir, id, 'meta.json'), 'utf8'));
    const why = await audit(meta, id);
    if (why) removed.push({ id, repo: meta.repo, why });
    else metas.push(meta);
  }
  for (const r of removed) (io.log ?? console.log)(`remove ${r.id}: ${r.why}`);
  if (dry || removed.length === 0) return { removed, kept: metas.length, changed: false };

  const next = dropFromSelection(selection, removed);
  const plan = await collect(metas);
  const text = notice(
    metas.map((m) => ({
      repo: m.repo,
      license: m.license,
      copyright: m.copyright,
      sha: m.commit,
    })),
    licenseDocs(plan),
  );

  // nothing above has touched the corpus; from here on only writes
  for (const r of removed) rmSync(join(casesDir, r.id), { recursive: true, force: true });
  writeFileSync(selPath, `${JSON.stringify(next, null, 2)}\n`);
  writeLicenseFiles(plan, base);
  writeFileSync(join(base, 'NOTICE.md'), text);
  return { removed, kept: metas.length, changed: true };
}

async function main(argv) {
  const { removed, kept, changed } = await prune({ dry: argv.includes('--dry') });
  if (changed) console.log(`removed ${removed.length}, ${kept} cases left`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
