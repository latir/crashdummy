#!/usr/bin/env node
// Builds corpus/label-data.json: everything a labeller needs, with no findings in it.
// Used by the hosted labelling page and by the blind model labelling sessions, so both see
// exactly the same material. Run `pnpm build` first (it uses packages/core/dist).
//
//   node corpus/tools/label-data.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const ORACLE_RULES = [
  'oracle/no-assertion',
  'oracle/weak-matcher',
  'oracle/interaction-only',
  'oracle/tautological-assertion',
  'oracle/swallowed-async',
  'oracle/mocks-subject',
  'oracle/tautological-mock',
];
export const DIFF_RULES = [
  'integrity/assertions-dropped',
  'integrity/matcher-weakened',
  'integrity/modifier-added',
];
export const REMOVED_RULES = ['integrity/test-removed'];

/** Unified diff of two texts, via git (already required by the project). */
export function unifiedDiff(before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'cd-diff-'));
  try {
    writeFileSync(join(dir, 'before'), before);
    writeFileSync(join(dir, 'after'), after);
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '-U4', 'before', 'after'], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return '';
    } catch (err) {
      // git diff exits 1 when the files differ
      const out = String(err.stdout ?? '');
      return out.split('\n').slice(4).join('\n'); // drop the header lines
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FUNCTION_INITS = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const MAX_HELPER_LINES = 40;
const MAX_HELPERS = 4;

/**
 * What a reader needs to understand a test that calls things defined elsewhere in the file:
 * the top-level functions, and the imports with where they come from.
 */
export function fileContext(program, source) {
  const functions = new Map();
  const imports = new Map();
  for (const top of program.body ?? []) {
    let n = top;
    if (n.type === 'ImportDeclaration') {
      for (const spec of n.specifiers ?? []) {
        if (spec.local?.name) imports.set(spec.local.name, n.source?.value ?? '?');
      }
      continue;
    }
    if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration;
    if (n.type === 'FunctionDeclaration' && n.id?.name) {
      functions.set(n.id.name, source.slice(top.start, top.end));
    } else if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations ?? []) {
        if (d.id?.type === 'Identifier' && d.init && FUNCTION_INITS.has(d.init.type)) {
          functions.set(d.id.name, source.slice(top.start, top.end));
        }
      }
    }
  }
  return { functions, imports };
}

/** Helpers a test calls, and imports it uses, found by name. Shown to the labeller as context. */
export function contextFor(testSource, ctx) {
  const names = new Set(testSource.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const helpers = [];
  for (const [name, text] of ctx.functions) {
    if (!names.has(name) || helpers.length >= MAX_HELPERS) continue;
    const lines = text.split('\n');
    const cut = lines.length > MAX_HELPER_LINES;
    helpers.push({
      name,
      source: (cut ? lines.slice(0, MAX_HELPER_LINES).concat(['// ...']) : lines).join('\n'),
    });
  }
  const from = [];
  for (const [name, spec] of ctx.imports) {
    if (names.has(name) && from.length < 8) from.push({ name, from: spec });
  }
  return { helpers, imports: from };
}

/** The source of each test, found with the parser rather than by guessing at braces. */
export function describeTests(core, path, source) {
  const analysis = core.analyzeTestFile(path, source, { resolve: false });
  if (analysis.errors.length > 0) return { error: String(analysis.errors[0].message ?? 'syntax') };
  const ctx = fileContext(analysis.file.program, source);
  const lines = source.split('\n');
  const byId = new Map(analysis.facts.map((f) => [f.id, f]));
  const tests = analysis.summary.tests.map((t) => {
    const f = byId.get(t.id);
    const node = f?.fn ?? f?.body;
    const startLine = t.loc.line;
    const endLine = node ? source.slice(0, node.end).split('\n').length : startLine;
    return {
      id: t.id,
      title: t.title ?? '(unnamed)',
      line: startLine,
      endLine,
      modifier: t.modifier ?? null,
      source: lines.slice(startLine - 1, endLine).join('\n'),
      context: contextFor(lines.slice(startLine - 1, endLine).join('\n'), ctx),
    };
  });
  return { tests };
}

export async function buildLabelData({ casesDir, core }) {
  const cases = [];
  for (const name of readdirSync(casesDir).sort()) {
    const dir = join(casesDir, name);
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const ext = readdirSync(dir).find((f) => f.startsWith('after.'));
    if (!ext) continue;
    const afterExt = ext.slice('after'.length);
    const after = readFileSync(join(dir, ext), 'utf8');
    const beforeFile = join(dir, `before${afterExt}`);
    const before = existsSync(beforeFile) ? readFileSync(beforeFile, 'utf8') : undefined;

    const now = describeTests(core, meta.path, after);
    if (now.error) continue;
    const prev = before === undefined ? undefined : describeTests(core, meta.path, before);
    const hasDiff = prev !== undefined && !prev.error;

    const tests = now.tests.map((t) => ({
      ...t,
      rules: hasDiff ? [...ORACLE_RULES, ...DIFF_RULES] : [...ORACLE_RULES],
    }));
    const removed = [];
    if (hasDiff) {
      const kept = new Set(now.tests.map((t) => t.id));
      for (const t of prev.tests) {
        if (!kept.has(t.id)) removed.push({ ...t, rules: [...REMOVED_RULES] });
      }
    }
    cases.push({
      id: name,
      set: meta.set,
      repo: meta.repo,
      url: meta.url,
      path: meta.path,
      agent: meta.agent,
      framework: meta.framework,
      // The whole file, so a labeller can read imports and helpers.
      source: after,
      diff: hasDiff ? unifiedDiff(before, after) : null,
      lines: after.split('\n').length,
      imports: [
        ...fileContext(
          core.analyzeTestFile(meta.path, after, { resolve: false }).file.program,
          after,
        ).imports,
      ].map(([name, from]) => ({ name, from })),
      tests,
      removed,
    });
  }
  return { schema: 1, rules: [...ORACLE_RULES, ...DIFF_RULES, ...REMOVED_RULES], cases };
}

async function main() {
  const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href);
  const data = await buildLabelData({ casesDir: join(root, 'corpus/cases'), core });
  writeFileSync(join(root, 'corpus/label-data.json'), JSON.stringify(data) + '\n');
  const tests = data.cases.reduce((n, c) => n + c.tests.length + c.removed.length, 0);
  console.log(`${data.cases.length} cases, ${tests} tests`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
