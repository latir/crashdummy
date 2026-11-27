import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from './harvest.mjs';
import { notice, select } from './select.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crashdummy-select-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Licence texts come from real clones, which these tests do not have. */
const collectLicenses = async (_io, _dir, entries) =>
  [...new Set(entries.map((e) => e.repo))].map((repo) => ({
    repo,
    dir: repo.replace('/', '__'),
    files: [{ name: 'LICENSE', bytes: Buffer.from(`licence of ${repo}`) }],
  }));

/** A pool with n files from n/2 repositories, written the way harvest.mjs writes it. */
function makePool(n, { extra = {} } = {}) {
  const pool = new Pool(join(dir, 'pool'));
  for (let i = 0; i < n; i++) {
    const id = `id${String(i).padStart(3, '0')}`;
    mkdirSync(join(pool.dir, 'files', id), { recursive: true });
    const text = extra[id]?.text ?? `// file ${i}\ntest('t${i}', () => {});\n`;
    writeFileSync(join(pool.dir, 'files', id, 'after.txt'), text);
    if (i % 2 === 0) writeFileSync(join(pool.dir, 'files', id, 'before.txt'), `// before ${i}\n`);
    pool.append(pool.candidates, {
      id,
      repo: `owner${Math.floor(i / 2)}/repo`,
      sha: `${i}`.padStart(40, 'a'),
      path: `src/f${i}.test.ts`,
      status: i % 2 === 0 ? 'M' : 'A',
      trailer: ['claude', 'codex'][i % 2],
      date: '2026-01-01T00:00:00Z',
      license: 'MIT',
      licenseFile: 'LICENSE',
      copyright: `Copyright (c) 2026 Owner${Math.floor(i / 2)}`,
    });
  }
  return pool;
}

/** Stands in for packages/core: frameworks and findings are decided by the test. */
function fakeCore({ findings = () => [], integrity = () => [], broken = [], empty = [] } = {}) {
  return {
    analyzeTestFile(path, source) {
      if (broken.some((s) => source.includes(s))) return { errors: [{}], summary: { tests: [] } };
      const none = empty.some((s) => source.includes(s));
      return {
        errors: [],
        summary: {
          framework: path.includes('f1') ? 'jest' : 'vitest',
          tests: none ? [] : [{ id: 't' }, { id: 'u' }],
        },
      };
    },
    checkOracle: (path) => ({ findings: findings(path).map((ruleId) => ({ ruleId })) }),
    checkIntegrity: (changes) => ({
      findings: integrity(changes[0].path).map((ruleId) => ({ ruleId, layer: 'integrity' })),
    }),
  };
}

const opts = (over = {}) => ({
  pool: join(dir, 'pool'),
  out: join(dir, 'out'),
  seed: 's',
  random: 10,
  target: 3,
  maxTargeted: 20,
  perRepo: 2,
  quotas: { vitest: 10, jest: 10 },
  ...over,
});

describe('select', () => {
  test('leaves out files with a syntax error, no tests, or a credential, and says how many', async () => {
    makePool(8, {
      extra: {
        id001: { text: "const BROKEN = 1;\ntest('x', () => {});\n" },
        id002: { text: '// EMPTY\n' },
        id003: { text: `const k = 'AKIA${'A'.repeat(16)}';\ntest('x', () => {});\n` },
      },
    });
    const r = await select(opts({ write: false }), {
      core: fakeCore({ broken: ['BROKEN'], empty: ['EMPTY'] }),
    });
    expect(r.excluded).toEqual({ 'syntax-error': 1, 'no-tests': 1, sensitive: 1 });
    expect(r.eligible).toBe(5);
  });

  test('the random set is the same whatever the rules say about the files', async () => {
    makePool(40);
    const quiet = await select(opts({ write: false }), { core: fakeCore() });
    const loud = await select(opts({ write: false }), {
      core: fakeCore({
        findings: (p) =>
          p.length % 2 ? ['oracle/weak-matcher'] : ['oracle/no-assertion', 'oracle/weak-matcher'],
      }),
    });
    const ids = (r) => r.cases.filter((c) => c.set === 'random').map((c) => c.f.id);
    expect(ids(quiet)).toEqual(ids(loud));
    expect(ids(quiet)).toHaveLength(10);
  });

  test('the same seed gives the same selection, another seed another', async () => {
    makePool(40);
    const pick = async (seed) =>
      (await select(opts({ write: false, seed }), { core: fakeCore() })).cases.map((c) => c.f.id);
    expect(await pick('a')).toEqual(await pick('a'));
    expect(await pick('a')).not.toEqual(await pick('b'));
  });

  test('targeted files come from what the random draw left, and meet each rule target', async () => {
    makePool(40);
    const core = fakeCore({
      findings: (p) => (Number(p.match(/f(\d+)/)[1]) % 3 === 0 ? ['oracle/weak-matcher'] : []),
    });
    const r = await select(opts({ write: false }), { core });
    const random = new Set(r.cases.filter((c) => c.set === 'random').map((c) => c.f.id));
    const targeted = r.cases.filter((c) => c.set === 'targeted').map((c) => c.f.id);
    expect(targeted.length).toBeGreaterThan(0);
    expect(targeted.some((id) => random.has(id))).toBe(false);
    expect(r.tally['oracle/weak-matcher']).toBeGreaterThanOrEqual(3);
  });

  test('integrity findings count only for files that have an old version', async () => {
    makePool(20);
    const core = fakeCore({ integrity: () => ['integrity/test-removed'] });
    const r = await select(opts({ write: false, random: 4 }), { core });
    for (const c of r.cases.filter((x) => x.set === 'targeted')) expect(c.f.before).toBeDefined();
    expect(r.tally['integrity/test-removed']).toBeGreaterThan(0);
  });

  test('never more than perRepo files from one repository across both sets', async () => {
    makePool(40);
    const core = fakeCore({ findings: () => ['oracle/weak-matcher'] });
    const r = await select(opts({ write: false, perRepo: 1, target: 50 }), { core });
    const repos = r.cases.map((c) => c.f.repo);
    expect(new Set(repos).size).toBe(repos.length);
  });

  test('writes cases, provenance, a notice and the selection record', async () => {
    makePool(12);
    const core = fakeCore({ findings: () => ['oracle/weak-matcher'] });
    const r = await select(opts({ random: 4, target: 2 }), { core, collectLicenses });
    const cases = readdirSync(join(dir, 'out', 'cases'));
    expect(cases).toHaveLength(r.cases.length);

    const first = r.cases[0].f;
    const folder = join(
      dir,
      'out',
      'cases',
      cases.find((c) => c.endsWith(first.id)),
    );
    expect(readFileSync(join(folder, 'after.test.ts'), 'utf8')).toBe(first.after);
    expect(existsSync(join(folder, 'before.test.ts'))).toBe(first.before !== undefined);
    const meta = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      id: first.id,
      set: 'random',
      repo: first.repo,
      commit: first.sha,
      license: 'MIT',
      agent: first.trailer,
      framework: 'vitest',
    });
    expect(meta.url).toBe(`https://github.com/${first.repo}/blob/${first.sha}/${first.path}`);

    const sel = JSON.parse(readFileSync(join(dir, 'out', 'selection.json'), 'utf8'));
    expect(sel).toMatchObject({ seed: 's', randomSize: 4, target: 2 });
    expect(sel.random).toHaveLength(4);
    expect([...sel.random, ...sel.targeted].sort()).toEqual([...cases].sort());
    const text = readFileSync(join(dir, 'out', 'NOTICE.md'), 'utf8');
    expect(text).toContain(`## ${first.repo}`);
    expect(text).toContain('Licence: MIT');
    // the licence texts go with the cases, and NOTICE.md points at them
    expect(text).toContain(`\`licenses/${first.repo.replace('/', '__')}/LICENSE\``);
    expect(
      readFileSync(join(dir, 'out', 'licenses', first.repo.replace('/', '__'), 'LICENSE'), 'utf8'),
    ).toBe(`licence of ${first.repo}`);
  });

  test('a licence that cannot be read stops the run before the old cases are replaced', async () => {
    makePool(12);
    await select(opts({ random: 4, write: true }), { core: fakeCore(), collectLicenses });
    const before = readdirSync(join(dir, 'out', 'cases')).sort();
    await expect(
      select(opts({ random: 2, write: true, seed: 'other' }), {
        core: fakeCore(),
        collectLicenses: async () => {
          throw new Error('cannot read LICENSE');
        },
      }),
    ).rejects.toThrow('cannot read LICENSE');
    expect(readdirSync(join(dir, 'out', 'cases')).sort()).toEqual(before);
  });

  test('running it again replaces the old cases instead of adding to them', async () => {
    makePool(12);
    await select(opts({ random: 6, write: true }), { core: fakeCore(), collectLicenses });
    await select(opts({ random: 3, write: true, seed: 'other' }), {
      core: fakeCore(),
      collectLicenses,
    });
    expect(readdirSync(join(dir, 'out', 'cases'))).toHaveLength(3);
  });
});

describe('notice', () => {
  test('one entry per repository, with licence, copyright and commits', () => {
    const text = notice([
      { repo: 'b/two', license: 'Apache-2.0', copyright: null, sha: 'b'.repeat(40) },
      { repo: 'a/one', license: 'MIT', copyright: 'Copyright (c) 2025 A', sha: 'a'.repeat(40) },
      { repo: 'a/one', license: 'MIT', copyright: 'Copyright (c) 2025 A', sha: 'c'.repeat(40) },
    ]);
    expect(text.indexOf('## a/one')).toBeLessThan(text.indexOf('## b/two'));
    expect(text).toContain('Copyright (c) 2025 A');
    expect(text).toContain('Files: 2');
    expect(text).toContain('Commits: aaaaaaaaaaaa, cccccccccccc');
    expect(text).toContain('Licence: Apache-2.0');
    expect(text).not.toContain('Licence text');
  });

  test('points at the bundled licence texts', () => {
    const text = notice(
      [{ repo: 'a/one', license: 'Apache-2.0', copyright: null, sha: 'a'.repeat(40) }],
      new Map([['a/one', ['licenses/a__one/LICENSE', 'licenses/a__one/NOTICE']]]),
    );
    expect(text).toContain('- Licence texts: `licenses/a__one/LICENSE`, `licenses/a__one/NOTICE`');
  });
});
