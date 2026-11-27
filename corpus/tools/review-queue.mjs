#!/usr/bin/env node
// Builds corpus/review-queue.json: the short list of things a person should look at, instead of
// labelling every test. See the hosted labelling page, "Review queue".
//
//   node corpus/tools/review-queue.mjs
//
// What goes in, in this order (the first five are "required", the last two are audits):
//   integrity   every integrity finding: they are gates, so a false positive costs the most
//   contested   an oracle finding the models did not all agree on
//   disputed    an oracle finding all three models say is not a problem (a few per rule)
//   missed      the engine reported nothing, but a model said there is a problem
//   flipped     the model majority changed between the two labelling rounds
//   audit-hit   a sample of oracle findings the models all agreed on (are they all right together?)
//   audit-clear a sample of "no problem" the models all agreed on, where the engine is also silent

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadData } from './labels.mjs';
import { seededRandom, shuffle } from './lib.mjs';
import { MODELS, loadLabels } from './measure.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const SEED = 'crashdummy-review-1';
export const AUDIT_HITS = 20;
export const AUDIT_CLEARS = 20;
export const DISPUTED_PER_RULE = 8;
export const ORDER = [
  'integrity',
  'contested',
  'disputed',
  'missed',
  'flipped',
  'audit-hit',
  'audit-clear',
];
export const REQUIRED = ['integrity', 'contested', 'disputed', 'missed', 'flipped'];

const isIntegrity = (rule) => rule.startsWith('integrity/');
const keyOf = (c, t, r) => `${c}|${t}|${r}`;
export const itemId = (key) => createHash('sha1').update(key).digest('hex').slice(0, 10);

/** The yes/no/unsure each model gave, in model order. */
const votes = (labels, c, t, r) => MODELS.map((m) => labels[m]?.get(c)?.get(t)?.get(r));
const yesCount = (v) => v.filter((x) => x === 'yes').length;
/** What the majority of the three said: 'yes' with 2 or more, otherwise 'no'. */
const majority = (v) => (yesCount(v) >= 2 ? 'yes' : 'no');

/**
 * The queue. `fired` maps `case|test|rule` to the engine's message; `labels` has `round1` and
 * `round2`, each { opus, sonnet, haiku } of case -> test -> rule -> label; `reasons` has the same
 * for the one-line reasons models gave (round 2).
 */
export function buildQueue({ data, fired, round1, round2, reasons = {}, seed = SEED }) {
  const picked = new Map(); // key -> { why: Set, ... }
  const all = [];
  for (const c of data.cases) {
    for (const t of [...c.tests, ...c.removed]) {
      for (const r of t.rules) {
        const key = keyOf(c.id, t.id, r);
        const v2 = votes(round2, c.id, t.id, r);
        const v1 = votes(round1, c.id, t.id, r);
        all.push({ c, t, r, key, v1, v2, engine: fired.get(key) });
      }
    }
  }
  const add = (item, why) => {
    const entry = picked.get(item.key) ?? { item, why: [] };
    if (!entry.why.includes(why)) entry.why.push(why);
    picked.set(item.key, entry);
  };

  const disputed = new Map();
  for (const item of all) {
    const { r, engine, v1, v2 } = item;
    const split = yesCount(v2) > 0 && yesCount(v2) < 3;
    const anyUnsure = v2.includes('unsure');
    if (engine !== undefined && isIntegrity(r)) add(item, 'integrity');
    else if (engine !== undefined && (split || anyUnsure)) add(item, 'contested');
    else if (engine !== undefined && yesCount(v2) === 0) {
      disputed.set(r, [...(disputed.get(r) ?? []), item]);
    }
    if (engine === undefined && yesCount(v2) > 0) add(item, 'missed');
    if (majority(v1) !== majority(v2)) add(item, 'flipped');
  }

  const random = seededRandom(seed);
  for (const rule of [...disputed.keys()].sort()) {
    for (const item of shuffle(disputed.get(rule), random).slice(0, DISPUTED_PER_RULE)) {
      add(item, 'disputed');
    }
  }
  const taken = (item) => picked.has(item.key);
  const hits = all.filter(
    (i) => i.engine !== undefined && !isIntegrity(i.r) && yesCount(i.v2) === 3 && !taken(i),
  );
  for (const item of shuffle(hits, random).slice(0, AUDIT_HITS)) add(item, 'audit-hit');
  const clears = all.filter(
    (i) =>
      i.engine === undefined &&
      i.v2.every((x) => x === 'no') &&
      i.v1.every((x) => x === 'no') &&
      !taken(i),
  );
  for (const item of shuffle(clears, random).slice(0, AUDIT_CLEARS)) add(item, 'audit-clear');

  const rank = (why) => Math.min(...why.map((w) => ORDER.indexOf(w)));
  const items = [...picked.values()]
    .sort(
      (a, b) =>
        rank(a.why) - rank(b.why) ||
        a.item.r.localeCompare(b.item.r) ||
        a.item.key.localeCompare(b.item.key),
    )
    .map(({ item, why }) => ({
      id: itemId(item.key),
      case: item.c.id,
      test: item.t.id,
      title: item.t.title,
      rule: item.r,
      why,
      required: why.some((w) => REQUIRED.includes(w)),
      engine: item.engine ?? null,
      votes: Object.fromEntries(
        MODELS.map((m, i) => [m, { r2: item.v2[i] ?? null, r1: item.v1[i] ?? null }]),
      ),
      reasons: Object.fromEntries(
        MODELS.flatMap((m) => {
          const text = reasons[m]?.get(`${item.c.id}|${item.t.id}|${item.r}`);
          return text ? [[m, text]] : [];
        }),
      ),
    }));
  return items;
}

/** One-line reasons models wrote, keyed `case|test|rule`, from a compact label file. */
export function loadReasons(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const [caseId, entry] of Object.entries(raw.cases ?? {})) {
    for (const [testId, t] of Object.entries(entry.tests ?? {})) {
      for (const [rule, text] of Object.entries(t.reason ?? {})) {
        out.set(`${caseId}|${testId}|${rule}`, text);
      }
    }
  }
  return out;
}

async function engineFindings(core, data, casesDir) {
  const fired = new Map();
  for (const c of data.cases) {
    const dir = join(casesDir, c.id);
    const ext = readdirSync(dir)
      .find((f) => f.startsWith('after.'))
      .slice('after'.length);
    const after = readFileSync(join(dir, `after${ext}`), 'utf8');
    const beforeFile = join(dir, `before${ext}`);
    const findings = core.checkOracle(c.path, after, { resolve: false }).findings;
    if (existsSync(beforeFile)) {
      findings.push(
        ...core
          .checkIntegrity(
            [{ path: c.path, kind: 'modified', before: readFileSync(beforeFile, 'utf8'), after }],
            { cwd: root },
          )
          .findings.filter((f) => f.layer === 'integrity'),
      );
    }
    for (const f of findings) {
      for (const t of f.tests ?? (f.test ? [f.test] : []))
        fired.set(keyOf(c.id, t, f.ruleId), f.message);
    }
  }
  return fired;
}

async function main() {
  const data = loadData();
  const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href);
  const labelsDir = join(root, 'corpus/labels');
  const load = (dir) =>
    Object.fromEntries(
      MODELS.map((m) => [m, loadLabels(data, join(dir, `labels.claude-${m}.json`))]),
    );
  const reasons = Object.fromEntries(
    MODELS.map((m) => [m, loadReasons(join(labelsDir, `labels.claude-${m}.json`))]),
  );
  const fired = await engineFindings(core, data, join(root, 'corpus/cases'));
  const items = buildQueue({
    data,
    fired,
    round1: load(join(labelsDir, 'round1')),
    round2: load(labelsDir),
    reasons,
  });
  writeFileSync(
    join(root, 'corpus/review-queue.json'),
    `${JSON.stringify({ seed: SEED, items })}\n`,
  );
  const count = (why) => items.filter((i) => i.why.includes(why)).length;
  console.log(
    `${items.length} items, ${items.filter((i) => i.required).length} required:`,
    Object.fromEntries(ORDER.map((w) => [w, count(w)])),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
