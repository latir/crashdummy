import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { auditCase, auditCases } from './audit.mjs';
import { defaultIo } from './harvest.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crashdummy-audit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MIT =
  'MIT License\n\nCopyright (c) 2024 Ada\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software without restriction.\n';
const ISC =
  'ISC License\n\nCopyright (c) 2024 Bo\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n';
const GPL = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n';
const test1 = (n) =>
  `import { test, expect } from 'vitest';\n${Array.from({ length: 14 }, (_, i) => `// ${n} ${i}`).join('\n')}\ntest('${n}', () => { expect(1).toBe(1); });\n`;

/** A repository with a list of commits; each is a map of path to text (null deletes). */
function repo(name, commits) {
  const path = join(dir, 'repos', name);
  mkdirSync(path, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
      cwd: path,
      encoding: 'utf8',
    });
  git('init', '-q');
  const shas = [];
  for (const files of commits) {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) {
        git('rm', '-q', file);
        continue;
      }
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    shas.push(git('rev-parse', 'HEAD').trim());
  }
  return { path, shas };
}

describe('auditCase', () => {
  test('a case whose both sides are covered by the licence passes', async () => {
    const { path, shas } = repo('o__r', [
      { LICENSE: MIT, 'src/a.test.ts': test1('a') },
      { 'src/a.test.ts': test1('a2') },
    ]);
    const meta = { commit: shas[1], path: 'src/a.test.ts', hasBefore: true };
    expect(await auditCase(defaultIo, path, meta)).toBeNull();
  });

  test('a rename out of a restricted directory does not carry its old version over', async () => {
    const { path, shas } = repo('o__r', [
      { LICENSE: MIT, 'ee/a.test.ts': test1('a') },
      { 'ee/a.test.ts': null, 'src/a.test.ts': test1('a') },
    ]);
    const meta = { commit: shas[1], path: 'src/a.test.ts', status: 'R', hasBefore: true };
    expect(await auditCase(defaultIo, path, meta)).toBe(
      'before: path is under a restricted directory',
    );
    // without the old file the same case is fine
    expect(await auditCase(defaultIo, path, { ...meta, hasBefore: false })).toBeNull();
  });

  test('a licence that changed at the parent commit is caught on the before side', async () => {
    const gpl = repo('o__gpl', [
      { LICENSE: GPL, 'a.test.ts': test1('a') },
      { LICENSE: MIT, 'a.test.ts': test1('b') },
    ]);
    expect(
      await auditCase(defaultIo, gpl.path, {
        commit: gpl.shas[1],
        path: 'a.test.ts',
        hasBefore: true,
      }),
    ).toBe('before: licence is not permissive (LICENSE)');

    const isc = repo('o__isc', [
      { LICENSE: ISC, 'a.test.ts': test1('a') },
      { LICENSE: MIT, 'a.test.ts': test1('b') },
    ]);
    expect(
      await auditCase(defaultIo, isc.path, {
        commit: isc.shas[1],
        path: 'a.test.ts',
        hasBefore: true,
      }),
    ).toBe("before: root licence (LICENSE) differs from the pinned commit's");
  });

  test('a restricted nested licence at the parent commit is caught on the before side', async () => {
    const { path, shas } = repo('o__r', [
      { LICENSE: MIT, 'pkg/LICENSE': GPL, 'pkg/a.test.ts': test1('a') },
      { 'pkg/LICENSE': MIT, 'pkg/a.test.ts': test1('b') },
    ]);
    expect(
      await auditCase(defaultIo, path, { commit: shas[1], path: 'pkg/a.test.ts', hasBefore: true }),
    ).toBe('before: pkg/LICENSE is not permissive');
  });

  test('a nested licence that differs from the root one fails the after side', async () => {
    const { path, shas } = repo('o__r', [
      { LICENSE: MIT, 'pkg/LICENSE': ISC, 'pkg/a.test.ts': test1('a') },
    ]);
    expect(await auditCase(defaultIo, path, { commit: shas[0], path: 'pkg/a.test.ts' })).toBe(
      'pkg/LICENSE differs from the root licence',
    );
  });
});

describe('auditCases', () => {
  function pool(metaFiles) {
    const casesDir = join(dir, 'cases');
    for (const [name, content] of Object.entries(metaFiles)) {
      mkdirSync(join(casesDir, name), { recursive: true });
      if (content !== undefined) writeFileSync(join(casesDir, name, 'meta.json'), content);
    }
    return { casesDir, reposDir: join(dir, 'repos') };
  }

  test('a case with a missing, malformed or incomplete meta.json fails the audit', async () => {
    const { casesDir, reposDir } = pool({
      'no-meta': undefined,
      broken: '{ not json',
      incomplete: '{"repo":"o/r"}',
    });
    const bad = await auditCases(defaultIo, casesDir, reposDir);
    expect(bad.map((b) => b.id)).toEqual(['broken', 'incomplete', 'no-meta']);
    for (const b of bad) expect(b.why).toMatch(/^meta\.json is missing or invalid/);
  });

  test('a case whose repository clone is missing fails instead of passing unchecked', async () => {
    const { casesDir, reposDir } = pool({
      lost: JSON.stringify({ repo: 'o/gone', commit: 'a'.repeat(40), path: 'a.test.ts' }),
    });
    const bad = await auditCases(defaultIo, casesDir, reposDir);
    expect(bad).toHaveLength(1);
    expect(bad[0].why).toMatch(/^could not check/);
  });

  test('cases that pass produce no failures', async () => {
    const { shas } = repo('o__r', [{ LICENSE: MIT, 'a.test.ts': test1('a') }]);
    const { casesDir, reposDir } = pool({
      ok: JSON.stringify({ repo: 'o/r', commit: shas[0], path: 'a.test.ts', hasBefore: false }),
    });
    expect(await auditCases(defaultIo, casesDir, reposDir)).toEqual([]);
  });
});
