#!/usr/bin/env node
// Re-derives what depends on the licence texts, for the cases already in corpus/cases: the
// `copyright` field of every meta.json (from the licence file at the pinned commit), the bundled
// licence texts under licenses/, and NOTICE.md. Run it after changing copyrightLine().
//
//   node corpus/tools/refresh.mjs          # rewrite
//   node corpus/tools/refresh.mjs --dry    # report only
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultIo, showBlob } from './harvest.mjs';
import { copyrightLine, repoDirName } from './lib.mjs';
import { collectLicenseFiles, licenseDocs, writeLicenseFiles } from './licenses.mjs';
import { notice } from './select.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function refresh({ root: base = root, dry = false } = {}, io = defaultIo) {
  const casesDir = join(base, 'cases');
  const reposDir = join(base, '.pool', 'repos');
  const metas = [];
  const changed = [];
  for (const id of readdirSync(casesDir).sort()) {
    const file = join(casesDir, id, 'meta.json');
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    const text = await showBlob(
      io,
      join(reposDir, repoDirName(meta.repo)),
      meta.commit,
      meta.licenseFile,
    );
    if (text === undefined)
      throw new Error(`${id}: cannot read ${meta.licenseFile} at ${meta.commit}`);
    const copyright = copyrightLine(text);
    if (copyright !== meta.copyright) {
      changed.push({ id, repo: meta.repo, from: meta.copyright, to: copyright });
      meta.copyright = copyright;
    }
    metas.push({ file, meta });
  }
  const plan = await collectLicenseFiles(
    io,
    reposDir,
    metas.map((m) => m.meta),
  );
  if (!dry) {
    for (const { file, meta } of metas) writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
    writeLicenseFiles(plan, base);
    writeFileSync(
      join(base, 'NOTICE.md'),
      notice(
        metas.map((m) => ({
          repo: m.meta.repo,
          license: m.meta.license,
          copyright: m.meta.copyright,
          sha: m.meta.commit,
        })),
        licenseDocs(plan),
      ),
    );
  }
  return { changed, cases: metas.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { changed, cases } = await refresh({ dry: process.argv.includes('--dry') });
  for (const c of changed) console.log(`${c.id}  ${c.repo}\n  - ${c.from}\n  + ${c.to}`);
  console.log(`${cases} case(s), ${changed.length} copyright line(s) changed`);
}
