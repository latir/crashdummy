#!/usr/bin/env node
// Checks and expands label files. Models write the compact format below; the hosted page's
// export and the reconciled `labels.json` use the full format described in LABELING.md.
//
//   node corpus/tools/labels.mjs check  corpus/labels/labels.opus.json
//   node corpus/tools/labels.mjs expand corpus/labels/labels.opus.json > full.json
//
// Compact format (a test that appears at all counts as reviewed; unlisted rules mean "no"):
//   { "labeller": "claude-opus", "schema": 1,
//     "cases": { "<case id>": { "file": "good"|"weak", "note": "...",
//        "tests": { "<test id>": { "yes": ["oracle/weak-matcher"], "unsure": [],
//                                  "reason": { "oracle/weak-matcher": "only checks it exists" } } } } } }

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadData() {
  return JSON.parse(readFileSync(join(root, 'corpus/label-data.json'), 'utf8'));
}

/** Problems with a compact label file, and how much of the corpus it covers. */
export function validate(data, labels) {
  const errors = [];
  const byCase = new Map(data.cases.map((c) => [c.id, c]));
  if (!labels || typeof labels !== 'object' || typeof labels.labeller !== 'string')
    errors.push('missing "labeller"');
  const cases = labels?.cases ?? {};
  let labelled = 0;
  let total = 0;
  for (const c of data.cases) total += c.tests.length + c.removed.length;
  for (const [caseId, entry] of Object.entries(cases)) {
    const c = byCase.get(caseId);
    if (!c) {
      errors.push(`unknown case ${caseId}`);
      continue;
    }
    if (entry.file !== 'good' && entry.file !== 'weak')
      errors.push(`${caseId}: "file" must be "good" or "weak"`);
    const tests = new Map([...c.tests, ...c.removed].map((t) => [t.id, t]));
    for (const [testId, t] of Object.entries(entry.tests ?? {})) {
      const known = tests.get(testId);
      if (!known) {
        errors.push(`${caseId}: unknown test ${JSON.stringify(testId)}`);
        continue;
      }
      labelled++;
      const yes = t.yes ?? [];
      const unsure = t.unsure ?? [];
      if (!Array.isArray(yes) || !Array.isArray(unsure)) {
        errors.push(`${caseId}/${testId}: "yes" and "unsure" must be arrays`);
        continue;
      }
      for (const r of [...yes, ...unsure]) {
        if (!known.rules.includes(r))
          errors.push(`${caseId}/${testId}: rule ${r} does not apply to this test`);
      }
      for (const r of yes) {
        if (unsure.includes(r)) errors.push(`${caseId}/${testId}: ${r} is both yes and unsure`);
        if (!t.reason?.[r]) errors.push(`${caseId}/${testId}: ${r} needs a reason`);
      }
      for (const r of unsure) {
        if (!t.reason?.[r]) errors.push(`${caseId}/${testId}: ${r} needs a reason`);
      }
    }
  }
  const missing = [];
  for (const c of data.cases) {
    const entry = cases[c.id];
    for (const t of [...c.tests, ...c.removed]) {
      if (!entry?.tests?.[t.id]) missing.push(`${c.id}/${t.id}`);
    }
    if (!entry) continue;
  }
  return { errors, labelled, total, missing };
}

/** The full per-rule format: every applicable rule gets yes, no or unsure. */
export function expand(data, labels) {
  const out = { labeller: labels.labeller, schema: 1, cases: {} };
  const byCase = new Map(data.cases.map((c) => [c.id, c]));
  for (const [caseId, entry] of Object.entries(labels.cases ?? {})) {
    const c = byCase.get(caseId);
    if (!c) continue;
    const tests = {};
    for (const t of [...c.tests, ...c.removed]) {
      const given = entry.tests?.[t.id];
      if (!given) continue;
      const m = {};
      for (const rule of t.rules) {
        const label = (given.yes ?? []).includes(rule)
          ? 'yes'
          : (given.unsure ?? []).includes(rule)
            ? 'unsure'
            : 'no';
        m[rule] = given.reason?.[rule] ? { label, reason: given.reason[rule] } : { label };
      }
      tests[t.id] = m;
    }
    out.cases[caseId] = { file: entry.file, ...(entry.note ? { note: entry.note } : {}), tests };
  }
  return out;
}

function main(argv) {
  const [cmd, file] = argv;
  if (!['check', 'expand'].includes(cmd) || !file) {
    console.error('usage: labels.mjs check|expand <file>');
    return 2;
  }
  const data = loadData();
  const labels = JSON.parse(readFileSync(file, 'utf8'));
  if (cmd === 'expand') {
    process.stdout.write(JSON.stringify(expand(data, labels), null, 2) + '\n');
    return 0;
  }
  const { errors, labelled, total, missing } = validate(data, labels);
  for (const e of errors.slice(0, 50)) console.error('error:', e);
  if (errors.length > 50) console.error(`... and ${errors.length - 50} more errors`);
  console.log(`${labelled} of ${total} tests labelled, ${missing.length} still to do`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
