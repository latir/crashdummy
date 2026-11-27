import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Pool, defaultIo, fetchCommits, nestedLicenseProblem, search, status } from './harvest.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crashdummy-harvest-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MIT =
  'MIT License\n\nCopyright (c) 2024 Ada\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software without restriction.\n';
const ISC =
  'ISC License\n\nCopyright (c) 2024 Bo\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n';
const GPL = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n';
const body = (name, n = 14) =>
  `import { test, expect } from 'vitest';\n${Array.from({ length: n }, (_, i) => `// ${name} ${i}`).join('\n')}\ntest('${name}', () => { expect(1).toBe(1); });\n`;

/** A local repository to fetch from, standing in for GitHub. */
function sourceRepo(name, license, licenseFile = 'LICENSE') {
  const path = join(dir, 'remotes', name);
  mkdirSync(path, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
      cwd: path,
      encoding: 'utf8',
    });
  const write = (file, text) => {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  git('config', 'uploadpack.allowFilter', 'true');
  write(licenseFile, license);
  write('src/a.test.ts', body('a'));
  write('src/keep.test.ts', body('keep'));
  write('src/old-name.test.ts', body('renamed'));
  write('src/gone.test.ts', body('gone'));
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  write('src/a.test.ts', body('a-changed'));
  write('src/b.spec.ts', body('b'));
  write('src/日本語.test.ts', body('unicode'));
  write('src/c.ts', 'export const c = 1;\n');
  write('src/tiny.test.ts', 'test("x", () => {});\n');
  git('mv', 'src/old-name.test.ts', 'src/new-name.test.ts');
  git('rm', '-q', 'src/gone.test.ts');
  git('add', '.');
  git('commit', '-q', '-m', 'two\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  return { path, sha: git('rev-parse', 'HEAD').trim() };
}

const io = (remotes) => ({
  ...defaultIo,
  remote: (repo) => remotes[repo],
  gitConfig: ['protocol.file.allow=always'],
  sleep: async () => {},
});

const commit = (repo, sha, extra = {}) => ({ repo, sha, trailer: 'claude', fork: false, ...extra });

describe('fetchCommits', () => {
  test('keeps the test files a commit adds or changes, with the old version, and nothing else', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/widgets': r.path }),
    );

    const kept = pool.readLines(pool.candidates);
    expect(kept.map((c) => c.path).sort()).toEqual([
      'src/a.test.ts',
      'src/b.spec.ts',
      'src/日本語.test.ts',
    ]);
    expect(stats.kept).toBe(3);
    // tiny test file, pure rename, delete and source file are all left out
    const a = kept.find((c) => c.path === 'src/a.test.ts');
    expect(a).toMatchObject({
      repo: 'acme/widgets',
      sha: r.sha,
      status: 'M',
      hasBefore: true,
      license: 'MIT',
      licenseFile: 'LICENSE',
      copyright: 'Copyright (c) 2024 Ada',
      trailer: 'claude',
      framework: 'vitest',
    });
    expect(readFileSync(join(pool.dir, 'files', a.id, 'after.txt'), 'utf8')).toContain('a-changed');
    expect(readFileSync(join(pool.dir, 'files', a.id, 'before.txt'), 'utf8')).toContain('// a 0');
    const b = kept.find((c) => c.path === 'src/b.spec.ts');
    expect(b).toMatchObject({ status: 'A', hasBefore: false });
  });

  /** A repository from commits given as {path: text|null}, the last of them the one fetched. */
  function history(name, commits) {
    const path = join(dir, 'remotes', name);
    mkdirSync(path, { recursive: true });
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
        cwd: path,
        encoding: 'utf8',
      });
    git('init', '-q', '-b', 'main');
    git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    git('config', 'uploadpack.allowFilter', 'true');
    commits.forEach((files, i) => {
      for (const [file, text] of Object.entries(files)) {
        if (text === null) git('rm', '-q', file);
        else {
          mkdirSync(join(path, file, '..'), { recursive: true });
          writeFileSync(join(path, file), text);
        }
      }
      git('add', '-A');
      git('commit', '-q', '-m', `c${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
    });
    return { path, sha: git('rev-parse', 'HEAD').trim() };
  }

  test('the old version of a file renamed out of a restricted directory is not kept', async () => {
    const r = history('renamed', [
      { LICENSE: MIT, 'ee/x.test.ts': body('x') },
      { 'ee/x.test.ts': null, 'src/x.test.ts': body('x').replace('// x 3', '// x three') },
    ]);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/renamed', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/renamed': r.path }),
    );
    const kept = pool.readLines(pool.candidates);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ path: 'src/x.test.ts', status: 'R', hasBefore: false });
    expect(existsSync(join(pool.dir, 'files', kept[0].id, 'before.txt'))).toBe(false);
    expect(stats.skipped['before-license']).toBe(1);
  });

  test('the old version is not kept when the parent commit had another licence', async () => {
    const r = history('relicensed', [
      { LICENSE: ISC, 'src/y.test.ts': body('y') },
      { LICENSE: MIT, 'src/y.test.ts': body('y-changed') },
    ]);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/relicensed', r.sha));
    await fetchCommits(pool, { limit: 100, perRepo: 5 }, io({ 'acme/relicensed': r.path }));
    const kept = pool.readLines(pool.candidates);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ license: 'MIT', hasBefore: false });
  });

  test('a file in a package with a different permissive licence is not taken', async () => {
    const r = history('mixed', [
      { LICENSE: MIT, 'packages/isc/LICENSE': ISC, 'packages/isc/z.test.ts': body('z') },
    ]);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/mixed', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/mixed': r.path }),
    );
    expect(pool.readLines(pool.candidates)).toEqual([]);
    expect(stats.skipped['nested-license']).toBe(1);
  });

  test('a file under a licence that does not allow copying is not taken', async () => {
    const r = sourceRepo('copyleft', GPL);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/copyleft', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/copyleft': r.path }),
    );
    expect(pool.readLines(pool.candidates)).toEqual([]);
    expect(stats.skipped).toEqual({ 'license:other': 1 });
  });

  test('forks, repeats and the per-repo cap', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/fork', r.sha, { fork: true }));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    const remotes = { 'acme/widgets': r.path, 'acme/fork': r.path };
    const stats = await fetchCommits(pool, { limit: 100, perRepo: 1 }, io(remotes));
    expect(stats.skipped.fork).toBe(1);
    expect(pool.readLines(pool.candidates)).toHaveLength(1); // cap of 1 for the repo
  });

  test('identical content from another repository is not collected twice', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/one', r.sha));
    pool.append(pool.commits, commit('acme/two', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/one': r.path, 'acme/two': r.path }),
    );
    expect(pool.readLines(pool.candidates)).toHaveLength(3);
    expect(stats.skipped.duplicate).toBe(3);
  });

  test('resumes: a second run does no more work', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    const remotes = { 'acme/widgets': r.path };
    await fetchCommits(pool, { limit: 100, perRepo: 5 }, io(remotes));
    const again = await fetchCommits(pool, { limit: 100, perRepo: 5 }, io(remotes));
    expect(again).toEqual({ fetched: 0, kept: 0, skipped: {} });
    expect(pool.readLines(pool.candidates)).toHaveLength(3);
  });

  test('a commit cut short by a cap is replayed when the cap is raised, without duplicates', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    const remotes = { 'acme/widgets': r.path };
    await fetchCommits(pool, { limit: 100, perRepo: 1 }, io(remotes));
    expect(pool.readLines(pool.candidates)).toHaveLength(1);
    await fetchCommits(pool, { limit: 100, perRepo: 5 }, io(remotes));
    const paths = pool
      .readLines(pool.candidates)
      .map((c) => c.path)
      .sort();
    expect(paths).toEqual(['src/a.test.ts', 'src/b.spec.ts', 'src/日本語.test.ts']);
    // and once it has been seen in full it is not looked at again
    const again = await fetchCommits(pool, { limit: 100, perRepo: 5 }, io(remotes));
    expect(again.fetched).toBe(0);
  });

  test('a file with a non-ASCII name is kept', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    await fetchCommits(pool, { limit: 100, perRepo: 5 }, io({ 'acme/widgets': r.path }));
    expect(pool.readLines(pool.candidates).map((c) => c.path)).toContain('src/日本語.test.ts');
  });

  test('a licence file that covers bundled code is not the project licence', async () => {
    const r = sourceRepo('bundled', MIT, 'LICENSE-3rdparty.txt');
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/bundled', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/bundled': r.path }),
    );
    expect(pool.readLines(pool.candidates)).toEqual([]);
    expect(stats.skipped).toEqual({ 'license:none': 1 });
  });

  test('an MIT licence with a non-commercial condition added is not taken', async () => {
    const r = sourceRepo(
      'restricted',
      `${MIT}\nAdditional condition: this software may only be used for non-commercial purposes.\n`,
    );
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/restricted', r.sha));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/restricted': r.path }),
    );
    expect(pool.readLines(pool.candidates)).toEqual([]);
    expect(stats.skipped).toEqual({ 'license:other': 1 });
  });

  test('a commit that cannot be fetched is recorded and skipped, not fatal', async () => {
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/missing', 'deadbeef'.repeat(5)));
    const stats = await fetchCommits(
      pool,
      { limit: 100, perRepo: 5 },
      io({ 'acme/missing': join(dir, 'nowhere') }),
    );
    expect(stats.skipped).toEqual({ 'fetch-failed': 1 });
  });

  test('a repository name that is not a name is refused before anything touches disk', async () => {
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('../../etc', 'a'.repeat(40)));
    const stats = await fetchCommits(pool, { limit: 100, perRepo: 5 }, io({}));
    expect(stats.skipped).toEqual({ 'bad-name': 1 });
  });

  test('stops at the limit', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    await fetchCommits(pool, { limit: 1, perRepo: 5 }, io({ 'acme/widgets': r.path }));
    expect(pool.readLines(pool.candidates)).toHaveLength(1);
  });

  test('status counts what is in the pool', async () => {
    const r = sourceRepo('widgets', MIT);
    const pool = new Pool(join(dir, 'pool'));
    pool.append(pool.commits, commit('acme/widgets', r.sha));
    await fetchCommits(pool, { limit: 100, perRepo: 5 }, io({ 'acme/widgets': r.path }));
    expect(status(pool)).toMatchObject({
      commits: 1,
      candidates: 3,
      repos: 1,
      withBefore: 1,
      byLicense: [['MIT', 3]],
      byFramework: [['vitest', 3]],
    });
  });
});

describe('search', () => {
  const item = (repo, sha, message, extra = {}) => ({
    sha,
    commit: { message, committer: { date: '2025-03-01T00:00:00Z' } },
    repository: { full_name: repo, fork: false, private: false },
    ...extra,
  });
  const options = { since: '2025-03-01', until: '2025-03-31', maxPages: 3 };

  function fake(pages) {
    const calls = [];
    return {
      calls,
      io: {
        ...defaultIo,
        sleep: async () => {},
        async search(q, page) {
          calls.push({ q, page });
          // the same hits are only returned for the first query, as one commit would be
          return { items: calls.length === 1 ? (pages[page - 1] ?? []) : [] };
        },
      },
    };
  }

  test('keeps only commits whose message really has the trailer', async () => {
    const pool = new Pool(join(dir, 'pool'));
    const f = fake([
      [
        item('a/b', '1'.repeat(40), 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'),
        item('a/c', '2'.repeat(40), 'fix: ask Claude less'),
        item('a/d', '3'.repeat(40), 'x\n\nCo-Authored-By: Claude', {
          repository: { full_name: 'a/d', private: true },
        }),
        item('a/e', '4'.repeat(40), 'x\n\nCo-Authored-By: Claude', {
          repository: { full_name: 'a/e', fork: true, private: false },
        }),
      ],
    ]);
    const r = await search(pool, options, f.io);
    expect(pool.readLines(pool.commits).map((c) => [c.repo, c.fork])).toEqual([
      ['a/b', false],
      ['a/e', true],
    ]);
    expect(r.rejected).toBe(2);
  });

  test('asks for each agent, query and month, and stops paging on a short page', async () => {
    const pool = new Pool(join(dir, 'pool'));
    const f = fake([[]]);
    await search(pool, options, f.io);
    const queries = new Set(f.calls.map((c) => c.q.split(' committer-date')[0]));
    expect(queries.size).toBe(6); // 2 claude + 2 codex + 1 copilot + 1 cursor
    expect(f.calls.every((c) => c.page === 1)).toBe(true);
    expect(f.calls[0].q).toContain('committer-date:2025-03-01..2025-03-31');
    expect(f.calls[0].q).toContain('is:public');
  });

  test('resumes without repeating finished requests, and does not duplicate a commit', async () => {
    const pool = new Pool(join(dir, 'pool'));
    const hit = item('a/b', '1'.repeat(40), 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const first = fake([[hit]]);
    await search(pool, options, first.io);
    const second = fake([[hit]]);
    const r = await search(pool, options, second.io);
    expect(second.calls).toEqual([]);
    expect(r.added).toBe(0);
    expect(pool.readLines(pool.commits)).toHaveLength(1);
  });

  test('retries a failed request', async () => {
    const pool = new Pool(join(dir, 'pool'));
    let fails = 2;
    const waits = [];
    const flaky = {
      ...defaultIo,
      sleep: async (ms) => waits.push(ms),
      async search() {
        if (fails-- > 0) throw new Error('rate limited');
        return { items: [] };
      },
    };
    await search(pool, { ...options, maxPages: 1 }, flaky);
    expect(waits.filter((ms) => ms >= 60000).length).toBe(2);
  });

  test('gives up after repeated failures', async () => {
    const pool = new Pool(join(dir, 'pool'));
    const broken = {
      ...defaultIo,
      sleep: async () => {},
      search: async () => {
        throw new Error('down');
      },
    };
    await expect(search(pool, options, broken)).rejects.toThrow('down');
  });
});

describe('nested licences', () => {
  function monorepo() {
    const path = join(dir, 'mono');
    mkdirSync(path, { recursive: true });
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
        cwd: path,
        encoding: 'utf8',
      });
    const write = (file, text) => {
      mkdirSync(join(path, file, '..'), { recursive: true });
      writeFileSync(join(path, file), text);
    };
    git('init', '-q');
    write('LICENSE', MIT);
    write('packages/a/LICENSE', MIT);
    write('packages/a/src/x.test.ts', body('x'));
    write('packages/b/LICENSE.md', GPL);
    write('packages/b/y.test.ts', body('y'));
    write('packages/d/LICENSE', ISC);
    write('packages/d/w.test.ts', body('w'));
    // the same text as the root with another holder is still the root's licence
    write('packages/e/LICENSE', MIT.replace('Ada', 'Cy'));
    write('packages/e/v.test.ts', body('v'));
    write('c/z.test.ts', body('z'));
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return { path, sha: git('rev-parse', 'HEAD').trim() };
  }

  test('a package carrying the same permissive licence is fine', async () => {
    const { path, sha } = monorepo();
    expect(await nestedLicenseProblem(defaultIo, path, sha, 'packages/a/src/x.test.ts')).toBeNull();
  });

  test('a package under a different licence is reported', async () => {
    const { path, sha } = monorepo();
    expect(await nestedLicenseProblem(defaultIo, path, sha, 'packages/b/y.test.ts')).toBe(
      'packages/b/LICENSE.md is not permissive',
    );
  });

  test('a package under another permissive licence is not the root licence', async () => {
    const { path, sha } = monorepo();
    expect(await nestedLicenseProblem(defaultIo, path, sha, 'packages/d/w.test.ts')).toBe(
      'packages/d/LICENSE differs from the root licence',
    );
  });

  test('the same licence text with another copyright holder is fine', async () => {
    const { path, sha } = monorepo();
    expect(await nestedLicenseProblem(defaultIo, path, sha, 'packages/e/v.test.ts')).toBeNull();
  });

  test('a directory with no licence of its own is covered by the root', async () => {
    const { path, sha } = monorepo();
    expect(await nestedLicenseProblem(defaultIo, path, sha, 'c/z.test.ts')).toBeNull();
  });
});
