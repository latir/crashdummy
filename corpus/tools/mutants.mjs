#!/usr/bin/env node
// Synthetic mutants: break real test files in known ways and check that crashdummy notices, and
// make harmless edits and check that it stays quiet. The right answer is known by construction,
// so no human labels are needed. Run `pnpm build` first (it uses packages/core/dist).
//
//   node corpus/tools/mutants.mjs                 # table, and writes corpus/mutants.json
//   node corpus/tools/mutants.mjs --check         # exits 1 if recall or quiet-rate drop below the bars
//
// Two kinds of mutant:
//   breaking   a known defect, expected to produce a specific finding on a specific test
//   harmless   an edit that changes nothing that matters; expected to produce no new finding

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seededRandom, shuffle } from './lib.mjs';
import { wilson } from './measure.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const PER_OPERATOR = 30;
export const SEED = 'crashdummy-mutants-1';
/** A breaking mutant must be caught at least this often, a harmless one flagged at most this often. */
export const MIN_RECALL = 0.9;
export const MAX_NOISE = 0.02;

const lineStarts = (source) => {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
};

/** Start offset of a test call, from its line and column (both 1-based in the facts). */
function testStart(source, starts, loc) {
  const off = (starts[loc.line - 1] ?? 0) + loc.col - 1;
  return /^(test|it)\b/.test(source.slice(off)) ? off : -1;
}

const edit = (source, from, to, text) => source.slice(0, from) + text + source.slice(to);

/** Apply several non-overlapping edits, last first so offsets stay valid. */
function editAll(source, edits) {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = edit(out, e.from, e.to, e.text);
  return out;
}

/** The assertions of a test that are plain `expect(...).matcher(...)` chains written in the test. */
function expectChains(f) {
  return f.assertions.filter(
    (a) =>
      !a.custom &&
      !a.viaHelper &&
      !a.typeLevel &&
      a.node.callee?.type === 'MemberExpression' &&
      a.node.callee.property &&
      a.matcher.startsWith('to'),
  );
}

/**
 * Every mutant this file offers. `analysis` is `core.analyzeTestFile(...)`. Each result has:
 * `op`, `kind` ('breaking' | 'harmless'), `layer` ('integrity' | 'oracle'), `testId`,
 * `expected` (rule id, for breaking ones) and the `after` source.
 */
export function candidates(analysis, source) {
  const starts = lineStarts(source);
  const out = [];
  const tests = analysis.facts.filter((f) => f.modifier === undefined);
  const add = (m) => out.push({ ...m });

  for (const f of tests) {
    const chains = expectChains(f);
    const onlyChains =
      f.assertions.length > 0 && f.assertions.every((a) => chains.includes(a)) && chains.length > 0;

    // --- breaking: integrity (compared with the original) ---
    if (chains.length >= 2) {
      const a = chains[0];
      add({
        op: 'drop-assertion',
        kind: 'breaking',
        layer: 'integrity',
        testId: f.id,
        expected: 'integrity/assertions-dropped',
        after: edit(source, a.node.start, a.node.end, 'void 0'),
      });
    }
    const strong = chains.find(
      (a) => a.strength >= 3 && !a.negated && !/^(toThrow|toHaveBeen|toBeCalled)/.test(a.matcher),
    );
    if (strong) {
      add({
        op: 'weaken-matcher',
        kind: 'breaking',
        layer: 'integrity',
        testId: f.id,
        expected: 'integrity/matcher-weakened',
        after: edit(source, strong.node.callee.property.start, strong.node.end, 'toBeTruthy()'),
      });
    }
    const start = testStart(source, starts, f.loc);
    const callee = start >= 0 ? /^(test|it)/.exec(source.slice(start))[0] : undefined;
    if (callee) {
      add({
        op: 'add-skip',
        kind: 'breaking',
        layer: 'integrity',
        testId: f.id,
        expected: 'integrity/modifier-added',
        after: edit(source, start + callee.length, start + callee.length, '.skip'),
      });
      add({
        op: 'add-only',
        kind: 'breaking',
        layer: 'integrity',
        testId: f.id,
        expected: 'integrity/modifier-added',
        after: edit(source, start + callee.length, start + callee.length, '.only'),
      });
    }
    if (callee && f.fn && tests.length >= 2) {
      // from the call to its closing parenthesis and optional semicolon
      const tail = /^\s*,?\s*\)\s*;?/.exec(source.slice(f.fn.end));
      if (tail) {
        add({
          op: 'remove-test',
          kind: 'breaking',
          layer: 'integrity',
          testId: f.id,
          expected: 'integrity/test-removed',
          after: edit(source, start, f.fn.end + tail[0].length, ''),
        });
      }
    }

    // --- breaking: oracle (compared with the original file's findings) ---
    if (onlyChains) {
      add({
        op: 'strip-assertions',
        kind: 'breaking',
        layer: 'oracle',
        testId: f.id,
        expected: 'oracle/no-assertion',
        after: editAll(
          source,
          chains.map((a) => ({ from: a.node.start, to: a.node.end, text: 'void 0' })),
        ),
      });
      const weakable = chains.filter((a) => !a.negated && a.node.callee.property);
      if (weakable.length === chains.length) {
        add({
          op: 'weaken-all',
          kind: 'breaking',
          layer: 'oracle',
          testId: f.id,
          expected: 'oracle/weak-matcher',
          after: editAll(
            source,
            weakable.map((a) => ({
              from: a.node.callee.property.start,
              to: a.node.end,
              text: 'toBeTruthy()',
            })),
          ),
        });
      }
    }
    if (chains.length > 0) {
      const a = chains[0];
      add({
        op: 'tautology',
        kind: 'breaking',
        layer: 'oracle',
        testId: f.id,
        expected: 'oracle/tautological-assertion',
        after: edit(source, a.node.start, a.node.end, 'expect(1).toBe(1)'),
      });
    }
    for (const a of chains) {
      const before = source.slice(Math.max(0, a.node.start - 8), a.node.start);
      const text = source.slice(a.node.start, a.node.end);
      const aw = /await\s+$/.exec(before);
      if (aw && /\.(resolves|rejects)\./.test(text)) {
        add({
          op: 'swallow-async',
          kind: 'breaking',
          layer: 'oracle',
          testId: f.id,
          expected: 'oracle/swallowed-async',
          after: edit(source, a.node.start - aw[0].length, a.node.start, ''),
        });
        break;
      }
    }

    // --- harmless: integrity must stay quiet ---
    const title =
      start >= 0 ? /^(test|it)\(\s*(['"])([^'"\\\n]*)\2/.exec(source.slice(start)) : null;
    if (title) {
      const at = start + title[0].length - 1; // the closing quote
      add({
        op: 'rename-test',
        kind: 'harmless',
        layer: 'integrity',
        testId: f.id,
        after: edit(source, at, at, ' (renamed)'),
      });
    }
    const eq = chains.find((a) => a.matcher === 'toEqual' && !a.negated);
    if (eq) {
      add({
        op: 'strengthen-matcher',
        kind: 'harmless',
        layer: 'integrity',
        testId: f.id,
        after: edit(
          source,
          eq.node.callee.property.start,
          eq.node.callee.property.end,
          'toStrictEqual',
        ),
      });
    }
    // a rewritten test: new name, and an expected value that changed with the behaviour
    const num = chains.find(
      (a) =>
        a.matcher === 'toBe' &&
        !a.negated &&
        a.node.arguments?.[0]?.type === 'Literal' &&
        typeof a.node.arguments[0].value === 'number',
    );
    if (title && num) {
      const arg = num.node.arguments[0];
      add({
        op: 'rename-and-retune',
        kind: 'harmless',
        layer: 'integrity',
        testId: f.id,
        after: editAll(source, [
          {
            from: start + title[0].length - 1,
            to: start + title[0].length - 1,
            text: ' (renamed)',
          },
          { from: arg.start, to: arg.end, text: String(arg.value + 1) },
        ]),
      });
    }
    // `toContain('x')` and `toMatch('x')` say the same thing about a string
    const contain = chains.find(
      (a) =>
        a.matcher === 'toContain' &&
        !a.negated &&
        a.node.arguments?.[0]?.type === 'Literal' &&
        typeof a.node.arguments[0].value === 'string',
    );
    if (contain) {
      add({
        op: 'swap-sibling-matcher',
        kind: 'harmless',
        layer: 'integrity',
        testId: f.id,
        after: edit(
          source,
          contain.node.callee.property.start,
          contain.node.callee.property.end,
          'toMatch',
        ),
      });
    }
    if (callee && f.fn) {
      const tail = /^\s*,?\s*\)\s*;?/.exec(source.slice(f.fn.end));
      if (tail) {
        const whole = source.slice(start, f.fn.end + tail[0].length);
        const copy = title
          ? whole.replace(title[0], `${title[0].slice(0, -1)} copy${title[2]}`)
          : undefined;
        if (copy) {
          add({
            op: 'add-test',
            kind: 'harmless',
            layer: 'integrity',
            testId: f.id,
            after: edit(source, start, start, `${copy}\n\n`),
          });
        }
      }
    }
  }
  return out;
}

const keyOf = (f) => f.tests ?? (f.test ? [f.test] : []);

/** Whether a mutant is caught, or (for harmless ones) quiet. `core` is the built engine. */
export function judge(core, path, original, m) {
  if (m.layer === 'oracle') {
    const was = new Set(
      core
        .checkOracle(path, original, { resolve: false })
        .findings.map((f) => `${f.ruleId}|${f.test}`),
    );
    const now = core.checkOracle(path, m.after, { resolve: false }).findings;
    const fresh = now.filter((f) => !was.has(`${f.ruleId}|${f.test}`));
    if (m.kind === 'breaking') {
      return { ok: fresh.some((f) => f.ruleId === m.expected && f.test === m.testId), got: fresh };
    }
    return { ok: fresh.length === 0, got: fresh };
  }
  const found = core.checkIntegrity(
    [{ path, kind: 'modified', before: original, after: m.after }],
    { cwd: root, exists: () => true },
  ).findings;
  const own = found.filter((f) => f.layer === 'integrity');
  if (m.kind === 'breaking') {
    return {
      ok: own.some((f) => f.ruleId === m.expected && keyOf(f).includes(m.testId)),
      got: own,
    };
  }
  return { ok: own.length === 0, got: own };
}

/** Mutants for every case, a fixed number per operator and kind, picked by a seeded shuffle. */
export function sample(all, perOperator = PER_OPERATOR, seed = SEED) {
  const byOp = new Map();
  for (const m of all) byOp.set(m.op, [...(byOp.get(m.op) ?? []), m]);
  const random = seededRandom(seed);
  const out = [];
  for (const op of [...byOp.keys()].sort()) {
    out.push(...shuffle(byOp.get(op), random).slice(0, perOperator));
  }
  return out;
}

export function summarize(results) {
  const ops = {};
  for (const r of results) {
    const o = (ops[r.op] ??= {
      kind: r.kind,
      expected: r.expected ?? null,
      n: 0,
      ok: 0,
      failures: [],
    });
    o.n++;
    if (r.ok) o.ok++;
    else o.failures.push({ case: r.caseId, test: r.testId, got: r.got });
  }
  for (const o of Object.values(ops)) {
    o.rate = o.n ? o.ok / o.n : null;
    o.interval = o.n ? wilson(o.ok, o.n) : null;
  }
  return ops;
}

/** Whether every operator meets the bar. */
export function failing(ops) {
  return Object.entries(ops)
    .filter(([, o]) => (o.kind === 'breaking' ? o.rate < MIN_RECALL : 1 - o.rate > MAX_NOISE))
    .map(([op]) => op);
}

async function main(argv) {
  const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href);
  const casesDir = join(root, 'corpus/cases');
  const all = [];
  const originals = new Map();
  for (const id of readdirSync(casesDir).sort()) {
    const dir = join(casesDir, id);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    const ext = readdirSync(dir)
      .find((f) => f.startsWith('after.'))
      .slice('after'.length);
    const source = readFileSync(join(dir, `after${ext}`), 'utf8');
    const analysis = core.analyzeTestFile(meta.path, source, { resolve: false });
    if (analysis.errors.length > 0) continue;
    originals.set(id, { path: meta.path, source });
    for (const m of candidates(analysis, source)) {
      // a mutant that does not parse is a bad mutant, not a missed defect
      if (core.analyzeTestFile(meta.path, m.after, { resolve: false }).errors.length > 0) continue;
      all.push({ ...m, caseId: id });
    }
  }
  const picked = sample(all);
  const results = picked.map((m) => {
    const o = originals.get(m.caseId);
    return { ...m, after: undefined, ...judge(core, o.path, o.source, m) };
  });
  const ops = summarize(results);
  console.log(
    'operator'.padEnd(20),
    'kind'.padEnd(9),
    'n'.padStart(3),
    'rate'.padStart(6),
    ' 95% interval',
  );
  for (const [op, o] of Object.entries(ops)) {
    const i = o.interval;
    console.log(
      op.padEnd(20),
      o.kind.padEnd(9),
      String(o.n).padStart(3),
      `${(o.rate * 100).toFixed(0)}%`.padStart(6),
      ` ${(i.low * 100).toFixed(0)}–${(i.high * 100).toFixed(0)}%`,
      o.kind === 'breaking' ? '(caught)' : '(quiet)',
    );
  }
  const bad = failing(ops);
  const strip = (ops) =>
    Object.fromEntries(
      Object.entries(ops).map(([k, o]) => [
        k,
        {
          ...o,
          failures: o.failures.map(({ case: c, test, got }) => ({
            case: c,
            test,
            got: got.map((f) => f.ruleId),
          })),
        },
      ]),
    );
  writeFileSync(
    join(root, 'corpus/mutants.json'),
    `${JSON.stringify({ seed: SEED, perOperator: PER_OPERATOR, operators: strip(ops) }, null, 2)}\n`,
  );
  if (argv.includes('--check') && bad.length > 0) {
    console.error(`below the bar: ${bad.join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
