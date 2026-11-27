#!/usr/bin/env node
// Measures every rule against the labelled corpus: precision with a Wilson interval, recall on the
// random set, agreement between labellers, and whether the rule ships on or off by default.
//
//   node corpus/tools/measure.mjs            # writes corpus/results.json and corpus/defaults.json
//   node corpus/tools/measure.mjs --check    # exits 1 if either file is out of date
//
// Ground truth, in this order (see LABELING.md): a human yes/no is final; a human "unsure" goes to
// the majority of the three models; with no human label, three unanimous models decide. Anything
// else is left out of the counts.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expand, loadData } from './labels.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A rule ships on by default only with at least this many labelled findings and this precision. */
export const MIN_FINDINGS = 20;
export const MIN_PRECISION = 0.9;
export const MODELS = ['opus', 'sonnet', 'haiku'];

/** 95% Wilson score interval for k of n. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Cohen's kappa for two raters over yes/no pairs. null when there is nothing to compare. */
export function cohen(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  let agree = 0;
  let a = 0;
  let b = 0;
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    if (x) a++;
    if (y) b++;
  }
  const po = agree / n;
  const pe = (a / n) * (b / n) + (1 - a / n) * (1 - b / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** Fleiss' kappa for `raters` raters; each item is an array of yes/no booleans of that length. */
export function fleiss(items) {
  const N = items.length;
  if (N === 0) return null;
  const n = items[0].length;
  let pBar = 0;
  let yes = 0;
  for (const item of items) {
    const y = item.filter(Boolean).length;
    yes += y;
    pBar += (y * (y - 1) + (n - y) * (n - y - 1)) / (n * (n - 1));
  }
  pBar /= N;
  const py = yes / (N * n);
  const pe = py * py + (1 - py) * (1 - py);
  return pe === 1 ? 1 : (pBar - pe) / (1 - pe);
}

/** The label to count for one test and rule, or null when it is left out. */
export function finalLabel(human, models) {
  if (human === 'yes' || human === 'no') return { label: human, source: 'human' };
  const given = models.filter((m) => m === 'yes' || m === 'no' || m === 'unsure');
  if (human === 'unsure') {
    const y = given.filter((m) => m === 'yes').length;
    const n = given.filter((m) => m === 'no').length;
    if (y > n) return { label: 'yes', source: 'models' };
    if (n > y) return { label: 'no', source: 'models' };
    return null;
  }
  if (given.length === models.length && given.every((m) => m === 'yes')) {
    return { label: 'yes', source: 'models-unanimous' };
  }
  if (given.length === models.length && given.every((m) => m === 'no')) {
    return { label: 'no', source: 'models-unanimous' };
  }
  return null;
}

/** Labels from a compact (models) or full (human export) file, as case -> test -> rule -> label. */
export function loadLabels(data, file) {
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  // models write the compact format, a human export has a label for every rule
  const compact = Object.values(raw.cases ?? {}).some((c) =>
    Object.values(c.tests ?? {}).some((t) => 'yes' in t || 'unsure' in t || 'reason' in t),
  );
  const full = compact ? expand(data, raw) : raw;
  const out = new Map();
  for (const [caseId, entry] of Object.entries(full.cases ?? {})) {
    const tests = new Map();
    for (const [testId, rules] of Object.entries(entry.tests ?? {})) {
      tests.set(testId, new Map(Object.entries(rules).map(([rule, v]) => [rule, v.label])));
    }
    out.set(caseId, tests);
  }
  return out;
}

/** Every (case, test, rule) the engine reported, as keys `case|test|rule`. */
export function findingKeys(core, data, casesDir) {
  const keys = new Set();
  const noTest = {};
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
      const tests = f.tests ?? (f.test ? [f.test] : []);
      if (tests.length === 0) noTest[f.ruleId] = (noTest[f.ruleId] ?? 0) + 1;
      for (const t of tests) keys.add(`${c.id}|${t}|${f.ruleId}`);
    }
  }
  return { keys, noTest };
}

/**
 * The numbers for every rule. `labels` is { human?: Map, models: { opus, sonnet, haiku } }, each a
 * case -> test -> rule -> label map; `fired` is the set from `findingKeys`.
 */
export function measure(data, labels, fired) {
  const rules = {};
  for (const rule of data.rules) {
    const items = [];
    for (const c of data.cases) {
      for (const t of [...c.tests, ...c.removed]) {
        if (!t.rules.includes(rule)) continue;
        const get = (m) => m?.get(c.id)?.get(t.id)?.get(rule);
        const modelLabels = MODELS.map((m) => get(labels.models[m]));
        items.push({
          set: c.set,
          fired: fired.has(`${c.id}|${t.id}|${rule}`),
          truth: finalLabel(get(labels.human), modelLabels),
          models: modelLabels,
        });
      }
    }
    const firedItems = items.filter((i) => i.fired);
    const decidedFired = firedItems.filter((i) => i.truth);
    const tp = decidedFired.filter((i) => i.truth.label === 'yes').length;
    const random = items.filter((i) => i.set === 'random' && i.truth);
    const randomYes = random.filter((i) => i.truth.label === 'yes');
    const caught = randomYes.filter((i) => i.fired).length;
    const randomFired = random.filter((i) => i.fired);
    const both = (i, j) => i.models[j] === 'yes' || i.models[j] === 'no';
    const kappas = {};
    for (let a = 0; a < MODELS.length; a++) {
      for (let b = a + 1; b < MODELS.length; b++) {
        kappas[`${MODELS[a]}-${MODELS[b]}`] = cohen(
          items
            .filter((i) => both(i, a) && both(i, b))
            .map((i) => [i.models[a] === 'yes', i.models[b] === 'yes']),
        );
      }
    }
    const allThree = items.filter((i) => MODELS.every((_, j) => both(i, j)));
    const precision = decidedFired.length ? tp / decidedFired.length : null;
    rules[rule] = {
      fired: firedItems.length,
      labelled: decidedFired.length,
      truePositives: tp,
      precision,
      precisionInterval: decidedFired.length ? wilson(tp, decidedFired.length) : null,
      randomSet: {
        problems: randomYes.length,
        caught,
        recall: randomYes.length ? caught / randomYes.length : null,
        falsePositives: randomFired.filter((i) => i.truth.label === 'no').length,
        tests: random.length,
      },
      agreement: {
        cohen: kappas,
        fleiss: fleiss(allThree.map((i) => i.models.map((m) => m === 'yes'))),
        items: allThree.length,
      },
      groundTruth: {
        human: items.filter((i) => i.truth?.source === 'human').length,
        models: items.filter((i) => i.truth && i.truth.source !== 'human').length,
      },
    };
  }
  return rules;
}

/** On or off by default, and why. */
export function defaultsFrom(rules) {
  const out = {};
  for (const [rule, r] of Object.entries(rules)) {
    if (r.labelled < MIN_FINDINGS) {
      out[rule] = {
        default: 'off',
        reason: `only ${r.labelled} labelled findings, need ${MIN_FINDINGS}`,
      };
    } else if (r.precision < MIN_PRECISION) {
      out[rule] = {
        default: 'off',
        reason: `precision ${(r.precision * 100).toFixed(0)}% is below ${MIN_PRECISION * 100}%`,
      };
    } else {
      out[rule] = {
        default: 'on',
        reason: `precision ${(r.precision * 100).toFixed(0)}% over ${r.labelled} findings`,
      };
    }
  }
  return out;
}

async function main(argv) {
  const data = loadData();
  const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href);
  const labelsDir = join(root, 'corpus/labels');
  const models = {};
  for (const m of MODELS) models[m] = loadLabels(data, join(labelsDir, `labels.claude-${m}.json`));
  const human = loadLabels(data, join(labelsDir, 'labels.human.json'));
  const { keys, noTest } = findingKeys(core, data, join(root, 'corpus/cases'));
  const rules = measure(data, { human, models }, keys);
  const results = {
    cases: data.cases.length,
    tests: data.cases.reduce((n, c) => n + c.tests.length + c.removed.length, 0),
    humanLabels: human !== undefined,
    findingsWithoutATest: noTest,
    rules,
  };
  const defaults = defaultsFrom(rules);
  const files = {
    'corpus/results.json': `${JSON.stringify(results, null, 2)}\n`,
    'corpus/defaults.json': `${JSON.stringify(defaults, null, 2)}\n`,
  };
  if (argv.includes('--check')) {
    const stale = Object.entries(files).filter(([f, text]) => {
      const p = join(root, f);
      return !existsSync(p) || readFileSync(p, 'utf8') !== text;
    });
    for (const [f] of stale) console.error(`${f} is out of date: run \`pnpm corpus:update\``);
    return stale.length ? 1 : 0;
  }
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
  for (const [rule, d] of Object.entries(defaults))
    console.log(`${d.default.padEnd(3)} ${rule}: ${d.reason}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
