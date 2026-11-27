#!/usr/bin/env node
// Picks the files that go into the labelled corpus (CD-6, step 2) and copies them into
// `corpus/cases/`. A development tool: it reads the pool made by harvest.mjs and needs the core
// package built (`pnpm build`), because it uses the real parser to tell frameworks apart and, for
// the targeted set only, the real rules.
//
//   node corpus/tools/select.mjs [--seed crashdummy-corpus-1] [--random 60] [--target 20] [--out corpus]
//
// Two samples, kept apart in every case's meta.json:
//   random    drawn from a seeded shuffle, before any rule runs. Nothing crashdummy says about a
//             file can influence this set, so it is the one that measures recall and the overall
//             false-positive rate.
//   targeted  picked because a rule fires, until every rule has `--target` findings to judge. It
//             measures precision only: the tool chose it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool, defaultIo } from './harvest.mjs';
import { collectLicenseFiles, licenseDocs, writeLicenseFiles } from './licenses.mjs';
import { caseSlug, drawRandom, drawTargeted, looksSensitive } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

export const DEFAULTS = {
  seed: 'crashdummy-corpus-1',
  random: 60,
  target: 20,
  maxTargeted: 150,
  perRepo: 3,
  // how many random files each framework may take (the rest of the draw fills any shortfall)
  quotas: { vitest: 24, 'node-test': 10, jest: 8, playwright: 8, unknown: 10 },
};

const extensionOf = (path) => path.slice(path.lastIndexOf('.'));

/**
 * What the real parser says about a file: its framework and how many tests it found. Nothing here
 * runs a rule, so the random draw stays blind to findings. A file with a syntax error cannot be
 * scored and is left out.
 */
export function inspect(core, candidate, source) {
  const analysis = core.analyzeTestFile(candidate.path, source, { resolve: false });
  if (analysis.errors.length > 0) return { ok: false, why: 'syntax-error' };
  if (analysis.summary.tests.length === 0) return { ok: false, why: 'no-tests' };
  return { ok: true, framework: analysis.summary.framework, tests: analysis.summary.tests.length };
}

/** Rule ids of every finding crashdummy reports for a file (and its before version, if any). */
export function findingsFor(core, candidate, after, before) {
  const ids = core
    .checkOracle(candidate.path, after, { resolve: false })
    .findings.map((f) => f.ruleId);
  if (before !== undefined) {
    const result = core.checkIntegrity(
      [{ path: candidate.path, kind: 'modified', before, after }],
      { cwd: root },
    );
    ids.push(...result.findings.filter((f) => f.layer === 'integrity').map((f) => f.ruleId));
  }
  return ids;
}

export async function select(options = {}, io = {}) {
  const o = { ...DEFAULTS, ...options };
  const core =
    io.core ?? (await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href));
  const pool = new Pool(o.pool ?? join(here, '..', '.pool'));
  const out = resolve(o.out ?? join(here, '..'));
  const read = (id, name) => {
    const file = join(pool.dir, 'files', id, name);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };

  // eligible: parses, has tests, no credentials. Framework comes from the parser.
  const excluded = { 'syntax-error': 0, 'no-tests': 0, sensitive: 0 };
  const eligible = [];
  for (const c of pool.readLines(pool.candidates)) {
    const after = read(c.id, 'after.txt');
    if (after === undefined) continue;
    const before = read(c.id, 'before.txt');
    if (looksSensitive(after) || (before !== undefined && looksSensitive(before))) {
      excluded.sensitive++;
      continue;
    }
    const info = inspect(core, c, after);
    if (!info.ok) {
      excluded[info.why]++;
      continue;
    }
    eligible.push({ ...c, framework: info.framework, tests: info.tests, after, before });
  }

  // 1. random: drawn before any rule has run
  const random = drawRandom(eligible, {
    size: o.random,
    quotas: o.quotas,
    perRepo: o.perRepo,
    seed: o.seed,
  });

  // 2. targeted: from what is left, by where the rules fire
  const rest = eligible.filter((f) => !random.includes(f));
  const findings = new Map(rest.map((f) => [f.id, findingsFor(core, f, f.after, f.before)]));
  const { chosen, tally } = drawTargeted(rest, findings, {
    target: o.target,
    perRepo: o.perRepo,
    max: o.maxTargeted,
    taken: random,
  });

  const cases = [
    ...random.map((f) => ({ f, set: 'random' })),
    ...chosen.map((f) => ({ f, set: 'targeted' })),
  ];

  if (o.write !== false) {
    // licence texts are read first: if one cannot be read, nothing has been replaced yet
    const collect = io.collectLicenses ?? collectLicenseFiles;
    const plan = await collect(
      io.git ?? defaultIo,
      join(pool.dir, 'repos'),
      cases.map((c) => c.f),
    );
    const dir = join(out, 'cases');
    rmSync(dir, { recursive: true, force: true });
    for (const { f, set } of cases) {
      const slug = caseSlug(f);
      const folder = join(dir, slug);
      mkdirSync(folder, { recursive: true });
      const ext = extensionOf(f.path);
      writeFileSync(join(folder, `after.test${ext}`), f.after);
      if (f.before !== undefined) writeFileSync(join(folder, `before.test${ext}`), f.before);
      writeFileSync(
        join(folder, 'meta.json'),
        `${JSON.stringify(
          {
            id: f.id,
            set,
            repo: f.repo,
            url: `https://github.com/${f.repo}/blob/${f.sha}/${f.path}`,
            commit: f.sha,
            path: f.path,
            status: f.status,
            agent: f.trailer,
            date: f.date,
            license: f.license,
            licenseFile: f.licenseFile,
            copyright: f.copyright,
            framework: f.framework,
            tests: f.tests,
            hasBefore: f.before !== undefined,
          },
          null,
          2,
        )}\n`,
      );
    }
    writeLicenseFiles(plan, out);
    writeFileSync(
      join(out, 'NOTICE.md'),
      notice(
        cases.map((c) => c.f),
        licenseDocs(plan),
      ),
    );
    writeFileSync(
      join(out, 'selection.json'),
      `${JSON.stringify(
        {
          seed: o.seed,
          randomSize: o.random,
          target: o.target,
          perRepo: o.perRepo,
          quotas: o.quotas,
          poolSize: eligible.length,
          excluded,
          random: random.map((f) => caseSlug(f)),
          targeted: chosen.map((f) => caseSlug(f)),
          targetedFindings: tally,
        },
        null,
        2,
      )}\n`,
    );
  }
  return {
    eligible: eligible.length,
    excluded,
    random: random.length,
    targeted: chosen.length,
    tally,
    cases,
  };
}

/** Every source repository with its licence and copyright line, as the licences require. */
export function notice(files, docs = new Map()) {
  const byRepo = new Map();
  for (const f of files) {
    const entry = byRepo.get(f.repo) ?? {
      license: f.license,
      copyright: f.copyright,
      sha: new Set(),
      files: 0,
    };
    entry.sha.add(f.sha);
    entry.files++;
    byRepo.set(f.repo, entry);
  }
  const lines = [
    '# Notice',
    '',
    'The files under `cases/` are test files from public repositories, copied unchanged to measure',
    'how well crashdummy judges real agent-written tests. Each is the property of its authors and is',
    'used under the licence of the repository it came from, listed below. Each case folder has a',
    '`meta.json` with the exact repository, commit and path. crashdummy only reads these files.',
    '',
  ];
  for (const [repo, e] of [...byRepo].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${repo}`, '');
    lines.push(`- Licence: ${e.license}`);
    if (e.copyright) lines.push(`- ${e.copyright}`);
    lines.push(`- Source: https://github.com/${repo}`);
    const docFiles = docs.get(repo) ?? [];
    if (docFiles.length > 0) {
      lines.push(
        `- Licence text${docFiles.length === 1 ? '' : 's'}: ${docFiles.map((f) => `\`${f}\``).join(', ')}`,
      );
    }
    lines.push(
      `- Commit${e.sha.size === 1 ? '' : 's'}: ${[...e.sha].map((s) => s.slice(0, 12)).join(', ')}`,
    );
    lines.push(`- Files: ${e.files}`, '');
  }
  lines.push(
    'The licence texts (and the NOTICE files that Apache-2.0 sources carry) are bundled under',
    '`licenses/`, copied unchanged from each source repository at the commit above. They have to',
    'stay with the files in `cases/` wherever those are redistributed.',
    '',
  );
  return lines.join('\n');
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const result = await select({
    seed: arg(argv, 'seed', DEFAULTS.seed),
    random: Number(arg(argv, 'random', String(DEFAULTS.random))),
    target: Number(arg(argv, 'target', String(DEFAULTS.target))),
    ...(arg(argv, 'out') ? { out: arg(argv, 'out') } : {}),
    ...(arg(argv, 'pool') ? { pool: arg(argv, 'pool') } : {}),
  });
  console.log(JSON.stringify({ ...result, cases: undefined }, null, 2));
}
