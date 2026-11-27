import { describe, expect, test } from 'vitest';
import {
  caseSlug,
  drawRandom,
  drawTargeted,
  looksSensitive,
  seededRandom,
  shuffle,
  candidateId,
  classifyLicense,
  isRestrictedPath,
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
  sameLicenseText,
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

  test('a licence that only turns into Apache 2.0 later is not Apache 2.0', () => {
    const fsl =
      '# Functional Source License, Version 1.1, ALv2 Future License\n\nCopyright 2026 Ada\n\n### Grant of Future License\n\nOn the second anniversary of the date the Software is made available, the Software will be made available under the Apache License, Version 2.0 ...';
    expect(classifyLicense(fsl)).toBeNull();
    expect(
      classifyLicense('Business Source License 1.1\n\nChange License: Apache License, Version 2.0'),
    ).toBeNull();
  });

  test('an MIT licence that leaves a directory under another licence is not MIT', () => {
    const carved = `${MIT}\n\nThe above applies to everything except the /ee directory, which has a separate license.`;
    expect(classifyLicense(carved)).toBeNull();
    expect(classifyLicense(MIT)).toBe('MIT');
  });

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

  test('the copyright line is not Apache clause 4(c) or the appendix template', () => {
    const apache = `${APACHE}
      4. Redistribution.
      (a) You must give any other recipients of the Work a copy of this License; and
      (c) You must retain, in the Source form of any Derivative Works that You distribute,
          all copyright, patent, trademark, and attribution notices from the Source form
      APPENDIX: How to apply the Apache License to your work.
      Copyright [yyyy] [name of copyright owner]

   Copyright 2023-present Operately doo
`;
    expect(copyrightLine(apache)).toBe('Copyright 2023-present Operately doo');
    // clause text alone is no copyright line
    expect(
      copyrightLine('(c) You must retain, in the Source form\nCopyright [yyyy] [owner]'),
    ).toBeNull();
  });

  test.each([
    ['Copyright (c) Microsoft Corporation', 'Copyright (c) Microsoft Corporation'],
    ['Copyright © 2024 Ada', 'Copyright © 2024 Ada'],
    ['© 2024 Ada', '© 2024 Ada'],
    ['(c) 2024 Ada', '(c) 2024 Ada'],
    ['copyright license to reproduce\nCopyright 2020 Bo', 'Copyright 2020 Bo'],
    ['(c) You must retain\n(c) 2019 Cy', '(c) 2019 Cy'],
  ])('copyright line of %j', (text, expected) => {
    expect(copyrightLine(text)).toBe(expected);
  });
});

describe('sameLicenseText', () => {
  const MIT =
    'MIT License\n\nCopyright (c) 2024 Ada Lovelace\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n';
  const ISC =
    'ISC License\n\nCopyright (c) 2024 Ada\n\nPermission to use, copy, modify, and/or distribute this software for any purpose.\n';
  test('ignores whitespace, case and copyright lines', () => {
    expect(sameLicenseText(MIT, MIT.replace('Ada Lovelace', 'Someone Else'))).toBe(true);
    expect(sameLicenseText(MIT, MIT.replace(/\n/g, '\r\n').toUpperCase())).toBe(true);
    expect(sameLicenseText(MIT, `${MIT}\n\nCopyright (c) 2025 Another`)).toBe(true);
  });
  test('a different text is different', () => {
    expect(sameLicenseText(MIT, `${MIT}\nAdditional clause.`)).toBe(false);
    expect(sameLicenseText(MIT, ISC)).toBe(false);
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

describe('selection helpers', () => {
  const file = (id, repo, framework = 'vitest') => ({ id, repo, framework });

  test('the same seed gives the same numbers, another seed gives others', () => {
    const a = seededRandom('x');
    const b = seededRandom('x');
    const c = seededRandom('y');
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  test('a shuffle keeps every item and is repeatable', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const s1 = shuffle(items, seededRandom('s'));
    expect([...s1].sort((p, q) => p - q)).toEqual(items);
    expect(shuffle(items, seededRandom('s'))).toEqual(s1);
    expect(s1).not.toEqual(items);
  });

  test('credentials are spotted', () => {
    expect(looksSensitive('const k = "AKIAABCDEFGHIJKLMNOP";')).toBe(true);
    expect(looksSensitive('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksSensitive(`token: 'ghp_${'a'.repeat(36)}'`)).toBe(true);
    expect(looksSensitive('expect(add(1, 2)).toBe(3); // sk-learn')).toBe(false);
  });

  test('random draw: respects quotas, the per-repo cap and the size, fills a shortfall', () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => file(`v${i}`, `r${i % 15}/x`, 'vitest')),
      ...Array.from({ length: 3 }, (_, i) => file(`j${i}`, `j${i}/x`, 'jest')),
    ];
    const opts = { size: 12, quotas: { vitest: 6, jest: 6 }, perRepo: 2, seed: 'a' };
    const out = drawRandom(files, opts);
    expect(out).toHaveLength(12);
    expect(out.filter((f) => f.framework === 'jest')).toHaveLength(3); // all there are
    expect(out.filter((f) => f.framework === 'vitest')).toHaveLength(9); // quota 6 plus the fill
    const perRepo = new Map();
    for (const f of out) perRepo.set(f.repo, (perRepo.get(f.repo) ?? 0) + 1);
    expect(Math.max(...perRepo.values())).toBeLessThanOrEqual(2);
    expect(drawRandom(files, opts).map((f) => f.id)).toEqual(out.map((f) => f.id));
    expect(drawRandom(files, { ...opts, seed: 'b' }).map((f) => f.id)).not.toEqual(
      out.map((f) => f.id),
    );
  });

  test('the random draw does not depend on anything but the files and the seed', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      ...file(`f${i}`, `r${i}/x`),
      findings: i,
    }));
    const a = drawRandom(files, { size: 10, quotas: { vitest: 10 }, perRepo: 3, seed: 's' });
    const b = drawRandom(
      files.map((f) => ({ ...f, findings: 99 - f.findings })),
      { size: 10, quotas: { vitest: 10 }, perRepo: 3, seed: 's' },
    );
    expect(b.map((f) => f.id)).toEqual(a.map((f) => f.id));
  });

  test('targeted draw: rarest rule first, one file counts for every rule in it', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((id, i) => file(id, `r${i}/x`));
    const findings = new Map([
      ['a', ['weak', 'weak', 'rare']],
      ['b', ['weak']],
      ['c', ['weak']],
      ['d', ['weak']],
      ['e', []],
    ]);
    const { chosen, tally } = drawTargeted(files, findings, { target: 3, perRepo: 3, max: 10 });
    expect(chosen.map((f) => f.id)).toEqual(['a', 'b']); // a: weak x2 + rare, then b makes 3 weak
    expect(tally).toEqual({ rare: 1, weak: 3 });
  });

  test('targeted draw: stops at the cap, respects the per-repo cap and earlier picks', () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`f${i}`, 'same/repo'));
    const findings = new Map(files.map((f) => [f.id, ['weak']]));
    const out = drawTargeted(files, findings, {
      target: 20,
      perRepo: 3,
      max: 10,
      taken: [file('t', 'same/repo')],
    });
    expect(out.chosen).toHaveLength(2); // 3 allowed for the repo, 1 already taken
    expect(drawTargeted(files, findings, { target: 20, perRepo: 99, max: 4 }).chosen).toHaveLength(
      4,
    );
  });

  test('case slugs are short, safe and unique per file', () => {
    const slug = caseSlug({ repo: 'Acme/Wid_gets.js', id: 'abc123def456' });
    expect(slug).toBe('acme-wid-gets-js-abc123def456');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(caseSlug({ repo: 'a/b', id: '1' })).not.toBe(caseSlug({ repo: 'a/b', id: '2' }));
  });
});

describe('restricted paths', () => {
  test.each([
    'packages/backend/src/ee/services/a.test.ts',
    'ee/billing.test.ts',
    'apps/web/enterprise/sso.spec.ts',
    'src/Commercial/x.test.ts',
  ])('%s is under a restricted directory', (p) => expect(isRestrictedPath(p)).toBe(true));

  test.each(['src/employee/a.test.ts', 'src/feed/a.test.ts', 'tests/premium-plan.test.ts'])(
    '%s is not',
    (p) => expect(isRestrictedPath(p)).toBe(false),
  );
});
