import { execFileSync } from 'node:child_process';
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
import { defaultIo } from './harvest.mjs';
import {
  collectLicenseFiles,
  copyLicenseFiles,
  licenseDocs,
  writeLicenseFiles,
} from './licenses.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crashdummy-licenses-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// CRLF line ends and a byte that is not UTF-8: a copy has to keep both
const APACHE = Buffer.concat([
  Buffer.from('Apache License\r\nVersion 2.0, January 2004\r\n'),
  Buffer.from([0xe9, 0x0a]),
]);
const NOTICE = Buffer.from('Example\nCopyright 2024 Example Inc.\n');

/** A clone in the pool layout with one commit per entry of `commits`; returns the shas. */
function repo(name, commits) {
  const path = join(dir, 'repos', name);
  mkdirSync(path, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
      cwd: path,
      encoding: 'utf8',
    });
  git('init', '-q');
  return commits.map((files) => {
    for (const [file, bytes] of Object.entries(files)) writeFileSync(join(path, file), bytes);
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    return git('rev-parse', 'HEAD').trim();
  });
}

const reposDir = () => join(dir, 'repos');

describe('collectLicenseFiles', () => {
  test('reads the licence and the NOTICE file as they are at the commit', async () => {
    const [sha] = repo('o__r', [{ LICENSE: APACHE, NOTICE, 'other.txt': 'x' }]);
    const plan = await collectLicenseFiles(defaultIo, reposDir(), [
      { repo: 'o/r', commit: sha, licenseFile: 'LICENSE' },
      { repo: 'o/r', sha, licenseFile: 'LICENSE' }, // a second case from the same commit
    ]);
    expect(plan.map((p) => [p.repo, p.dir, p.files.map((f) => f.name)])).toEqual([
      ['o/r', 'o__r', ['LICENSE', 'NOTICE']],
    ]);
    expect(plan[0].files[0].bytes.equals(APACHE)).toBe(true);
    expect(plan[0].files[1].bytes.equals(NOTICE)).toBe(true);
  });

  test('a licence that changed between two pinned commits is kept for both', async () => {
    const [a, b] = repo('o__r', [{ LICENSE: 'MIT one\n' }, { LICENSE: 'MIT two\n' }]);
    const plan = await collectLicenseFiles(defaultIo, reposDir(), [
      { repo: 'o/r', commit: a, licenseFile: 'LICENSE' },
      { repo: 'o/r', commit: b, licenseFile: 'LICENSE' },
    ]);
    const names = plan[0].files.map((f) => f.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('LICENSE');
    expect(names.some((n) => /^LICENSE\.[0-9a-f]{12}$/.test(n))).toBe(true);
  });

  test('a licence that cannot be read is an error, not a gap', async () => {
    repo('o__r', [{ LICENSE: 'x\n' }]);
    await expect(
      collectLicenseFiles(defaultIo, reposDir(), [
        { repo: 'o/r', commit: 'f'.repeat(40), licenseFile: 'LICENSE' },
      ]),
    ).rejects.toThrow();
  });
});

describe('copyLicenseFiles', () => {
  test('writes the files byte for byte under licenses/<repo-dir>/ and replaces old ones', async () => {
    const [sha] = repo('o__r', [{ LICENSE: APACHE, NOTICE }]);
    const out = join(dir, 'out');
    mkdirSync(join(out, 'licenses', 'stale__repo'), { recursive: true });
    writeFileSync(join(out, 'licenses', 'stale__repo', 'LICENSE'), 'old');

    const docs = await copyLicenseFiles(
      defaultIo,
      reposDir(),
      [{ repo: 'o/r', commit: sha, licenseFile: 'LICENSE' }],
      out,
    );
    expect(readdirSync(join(out, 'licenses'))).toEqual(['o__r']);
    expect(readFileSync(join(out, 'licenses', 'o__r', 'LICENSE')).equals(APACHE)).toBe(true);
    expect(readFileSync(join(out, 'licenses', 'o__r', 'NOTICE')).equals(NOTICE)).toBe(true);
    expect(docs.get('o/r')).toEqual(['licenses/o__r/LICENSE', 'licenses/o__r/NOTICE']);
  });

  test('nothing is written when a licence cannot be read', async () => {
    repo('o__r', [{ LICENSE: 'x\n' }]);
    const out = join(dir, 'out');
    await expect(
      copyLicenseFiles(
        defaultIo,
        reposDir(),
        [{ repo: 'o/r', commit: 'f'.repeat(40), licenseFile: 'LICENSE' }],
        out,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(out, 'licenses'))).toBe(false);
  });

  test('licenseDocs lists the stored paths by repository', () => {
    const plan = [
      { repo: 'a/b', dir: 'a__b', files: [{ name: 'LICENSE', bytes: Buffer.alloc(0) }] },
    ];
    expect(licenseDocs(plan).get('a/b')).toEqual(['licenses/a__b/LICENSE']);
    writeLicenseFiles(plan, join(dir, 'w'));
    expect(existsSync(join(dir, 'w', 'licenses', 'a__b', 'LICENSE'))).toBe(true);
  });
});
