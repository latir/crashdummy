import { describe, expect, test } from 'vitest';
import {
  candidateId,
  classifyLicense,
  contentHash,
  copyrightLine,
  detectFramework,
  findLicenseFile,
  interestingChanges,
  interleave,
  isTestPath,
  monthWindows,
  parseNameStatus,
  repoDirName,
  usableSource,
  verifyTrailer,
} from './lib.mjs';

describe('verifyTrailer', () => {
  test.each([
    ['feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', 'claude'],
    ['x\n\nco-authored-by: claude <noreply@anthropic.com>', 'claude'],
    ['x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', 'claude'],
    ['x\n\nCo-authored-by: Codex <codex@openai.com>', 'codex'],
    ['x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>', 'copilot'],
    ['x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', 'cursor'],
  ])('%j is %s', (message, agent) => {
    expect(verifyTrailer(message)).toBe(agent);
  });

  test.each([
    'fix: ask Claude less often',
    'docs: mention Co-Authored-By: Claude in the guide', // not at the start of a line
    'chore: update claude.md',
    'x\n\nCo-authored-by: Alice <alice@example.com>',
    '',
  ])('%j is not an agent commit', (message) => {
    expect(verifyTrailer(message)).toBeNull();
  });
});

describe('isTestPath', () => {
  test.each([
    'src/cart.test.ts',
    'a/b/cart.spec.tsx',
    'x.test.mjs',
    'src/__tests__/cart.ts',
    'e2e/login.spec.js',
  ])('%s is a test', (p) => expect(isTestPath(p)).toBe(true));

  test.each([
    'src/cart.ts',
    'src/cart.test.d.ts',
    'node_modules/pkg/a.test.js',
    'vendor/x/a.test.js',
    'src/__snapshots__/a.test.ts',
    'dist/a.test.js',
    'src/generated/a.test.ts',
    'src/cart.test.py',
    'src/__tests__/helpers/data.json',
    'src/test.ts',
  ])('%s is not', (p) => expect(isTestPath(p)).toBe(false));
});

describe('git name-status (-z)', () => {
  const z = (...fields) => `${fields.join('\0')}\0`;
  const out = z(
    'A',
    'src/a.test.ts',
    'M',
    'src/b.test.ts',
    'R087',
    'old.test.ts',
    'new.test.ts',
    'R100',
    'x.test.ts',
    'y.test.ts',
    'D',
    'gone.test.ts',
    'A',
    'src/c.ts',
  );

  test('parses added, modified, renamed and deleted', () => {
    expect(parseNameStatus(out)).toEqual([
      { status: 'A', similarity: 100, path: 'src/a.test.ts' },
      { status: 'M', similarity: 100, path: 'src/b.test.ts' },
      { status: 'R', similarity: 87, oldPath: 'old.test.ts', path: 'new.test.ts' },
      { status: 'R', similarity: 100, oldPath: 'x.test.ts', path: 'y.test.ts' },
      { status: 'D', similarity: 100, path: 'gone.test.ts' },
      { status: 'A', similarity: 100, path: 'src/c.ts' },
    ]);
  });

  test('keeps test files with real changes: not a pure rename, not a delete, not source', () => {
    expect(interestingChanges(parseNameStatus(out)).map((e) => e.path)).toEqual([
      'src/a.test.ts',
      'src/b.test.ts',
      'new.test.ts',
    ]);
  });

  test('paths with non-ASCII characters, tabs and quotes come through whole', () => {
    const paths = ['src/日本語.test.ts', 'src/a\tb.test.ts', 'src/say "hi".test.ts'];
    const parsed = parseNameStatus(z('A', paths[0], 'M', paths[1], 'R090', 'o.test.ts', paths[2]));
    expect(parsed.map((e) => e.path)).toEqual(paths);
    expect(interestingChanges(parsed)).toHaveLength(3);
  });

  test('truncated or empty output does not throw', () => {
    expect(parseNameStatus('')).toEqual([]);
    expect(parseNameStatus('A\0')).toEqual([]);
    expect(parseNameStatus('R087\0old.test.ts\0')).toEqual([]);
  });
});

describe('licences', () => {
  const MIT =
    'MIT License\n\nCopyright (c) 2024 Ada Lovelace\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software without restriction, including without limitation the rights to use';
  const APACHE =
    '                                 Apache License\n                           Version 2.0, January 2004';
  const ISC =
    'ISC License\n\nCopyright (c) 2024, Ada\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted';
  const BSD =
    'Copyright (c) 2024, Ada\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n1. Redistributions of source code';
  const BSD3 = `${BSD}\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products`;

  test.each([
    [MIT, 'MIT'],
    [APACHE, 'Apache-2.0'],
    [ISC, 'ISC'],
    [BSD, 'BSD-2-Clause'],
    [BSD3, 'BSD-3-Clause'],
  ])('recognises %#', (text, spdx) => expect(classifyLicense(text)).toBe(spdx));

  test.each([
    'GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007',
    'Mozilla Public License Version 2.0',
    'All rights reserved.',
    'This is free and unencumbered software released into the public domain.',
    '',
  ])('does not accept %j', (text) => expect(classifyLicense(text)).toBeNull());

  test('a standard MIT grant with a restriction added is not MIT, wherever it is added', () => {
    const extra = [
      'Additional condition: This software may only be used for non-commercial purposes.',
      'Commercial use is prohibited.',
      'This software is for personal use only.',
    ];
    for (const line of extra) {
      expect(classifyLicense(`${MIT}\n\n${line}`)).toBeNull();
      expect(classifyLicense(`${line}\n\n${MIT}`)).toBeNull();
      expect(classifyLicense(`${ISC}\n\n${line}`)).toBeNull();
      expect(classifyLicense(`${BSD3}\n\n${line}`)).toBeNull();
    }
    expect(
      classifyLicense(MIT.replace('without restriction', 'for non-commercial use only')),
    ).toBeNull();
  });

  test('the Apache text mentions commercial damages and is still Apache', () => {
    expect(
      classifyLicense(`${APACHE}\n  other commercial damages or losses), even if such Contributor`),
    ).toBe('Apache-2.0');
  });

  test('finds the licence file, preferring the plain name', () => {
    expect(findLicenseFile(['README.md', 'LICENSE-3rdparty.txt', 'LICENSE.md', 'src'])).toBe(
      'LICENSE.md',
    );
    expect(findLicenseFile(['COPYING', 'a'])).toBe('COPYING');
    expect(findLicenseFile(['licence.txt'])).toBe('licence.txt');
    expect(findLicenseFile(['README.md', 'package.json'])).toBeNull();
  });

  test('licences of bundled code are not the project licence', () => {
    expect(findLicenseFile(['LICENSE-3rdparty.txt'])).toBeNull();
    expect(findLicenseFile(['LICENSE.vendor', 'THIRD-PARTY-LICENSE', 'LICENSES'])).toBeNull();
    expect(findLicenseFile(['LICENSE-3rdparty.txt', 'LICENSE'])).toBe('LICENSE');
  });

  test('the dual-licence forms are the project licence', () => {
    expect(findLicenseFile(['LICENSE-MIT', 'LICENSE-APACHE'])).toBe('LICENSE-MIT');
    expect(findLicenseFile(['LICENSE-APACHE.md'])).toBe('LICENSE-APACHE.md');
  });

  test('the copyright line', () => {
    expect(copyrightLine(MIT)).toBe('Copyright (c) 2024 Ada Lovelace');
    expect(copyrightLine(APACHE)).toBeNull();
  });
});

describe('usableSource', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  test('size bounds', () => {
    expect(usableSource(lines(5))).toBe(false);
    expect(usableSource(lines(10))).toBe(true);
    expect(usableSource(lines(2000))).toBe(true);
    expect(usableSource(lines(2001))).toBe(false);
  });
  test('binary or mis-decoded text is out', () => {
    expect(usableSource(`${lines(20)}\u0000`)).toBe(false);
    expect(usableSource(`${lines(20)}�`)).toBe(false);
  });
});

describe('small helpers', () => {
  test('framework guess', () => {
    expect(detectFramework("import { test } from 'vitest';")).toBe('vitest');
    expect(detectFramework("import { test } from '@playwright/test';")).toBe('playwright');
    expect(detectFramework("import test from 'node:test';")).toBe('node-test');
    expect(detectFramework("import { jest } from '@jest/globals';")).toBe('jest');
    expect(detectFramework("describe('x', () => {});")).toBe('unknown');
    expect(detectFramework('export const x = 1;')).toBe('other');
  });

  test('ids and hashes are stable and differ', () => {
    expect(candidateId('a/b', 'abc', 'x.test.ts')).toBe(candidateId('a/b', 'abc', 'x.test.ts'));
    expect(candidateId('a/b', 'abc', 'x.test.ts')).not.toBe(candidateId('a/b', 'abd', 'x.test.ts'));
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  test('a repo name becomes a safe folder name, anything else is refused', () => {
    expect(repoDirName('vitest-dev/vitest')).toBe('vitest-dev__vitest');
    for (const bad of ['../x', 'a/../b', 'a/b/c', 'a', '', 'a b/c', 'a/b;rm', '/etc/passwd']) {
      expect(() => repoDirName(bad)).toThrow();
    }
  });

  test('month windows cover the range without overlap', () => {
    expect(monthWindows('2025-01-15', '2025-03-10')).toEqual([
      ['2025-01-15', '2025-01-31'],
      ['2025-02-01', '2025-02-28'],
      ['2025-03-01', '2025-03-10'],
    ]);
    // the end date is included, including when it is the first of a month
    expect(monthWindows('2025-02-01', '2025-02-01')).toEqual([['2025-02-01', '2025-02-01']]);
    expect(monthWindows('2025-01-20', '2025-02-01')).toEqual([
      ['2025-01-20', '2025-01-31'],
      ['2025-02-01', '2025-02-01'],
    ]);
    expect(monthWindows('2025-03-02', '2025-03-01')).toEqual([]);
  });
});

describe('interleave', () => {
  const c = (trailer, repo, n) => ({ trailer, repo, sha: `${trailer}-${repo}-${n}` });
  test('takes turns across agents and, within an agent, across repositories', () => {
    const input = [
      c('claude', 'a/x', 1),
      c('claude', 'a/x', 2),
      c('claude', 'a/y', 1),
      c('codex', 'b/z', 1),
      c('codex', 'b/z', 2),
    ];
    expect(interleave(input).map((x) => x.sha)).toEqual([
      'claude-a/x-1',
      'codex-b/z-1',
      'claude-a/y-1',
      'codex-b/z-2',
      'claude-a/x-2',
    ]);
  });
  test('keeps every commit exactly once, and handles empty input', () => {
    const input = Array.from({ length: 30 }, (_, i) =>
      c(['claude', 'codex', 'cursor'][i % 3], `r/${i % 7}`, i),
    );
    expect(
      interleave(input)
        .map((x) => x.sha)
        .sort(),
    ).toEqual(input.map((x) => x.sha).sort());
    expect(interleave([])).toEqual([]);
  });
});
