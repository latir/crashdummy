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

async function main(argv) {
  const dry = argv.includes('--dry');
  const casesDir = join(root, 'cases');
  const removed = [];
  const metas = [];
  for (const id of readdirSync(casesDir).sort()) {
    const meta = JSON.parse(readFileSync(join(casesDir, id, 'meta.json'), 'utf8'));
    const dir = join(root, '.pool', 'repos', repoDirName(meta.repo));
    const why = await auditCase(defaultIo, dir, meta);
    if (why) removed.push({ id, repo: meta.repo, why });
    else metas.push(meta);
  }
  for (const r of removed) console.log(`remove ${r.id}: ${r.why}`);
  if (dry || removed.length === 0) return 0;
  for (const r of removed) rmSync(join(casesDir, r.id), { recursive: true, force: true });
  const selPath = join(root, 'selection.json');
  const selection = dropFromSelection(JSON.parse(readFileSync(selPath, 'utf8')), removed);
  writeFileSync(selPath, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(
    join(root, 'NOTICE.md'),
    notice(
      metas.map((m) => ({
        repo: m.repo,
        license: m.license,
        copyright: m.copyright,
        sha: m.commit,
      })),
    ),
  );
  console.log(`removed ${removed.length}, ${metas.length} cases left`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
