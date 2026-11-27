import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { dropFromSelection, prune } from './prune.mjs';

describe('dropFromSelection', () => {
  test('removes the cases from both sets and records why', () => {
    const out = dropFromSelection({ seed: 's', random: ['a', 'b'], targeted: ['c', 'd'] }, [
      { id: 'b', repo: 'o/r', why: 'licence' },
      { id: 'c', repo: 'o/q', why: 'nested' },
    ]);
    expect(out.random).toEqual(['a']);
    expect(out.targeted).toEqual(['d']);
    expect(out.removed.map((r) => r.id)).toEqual(['b', 'c']);
    expect(out.seed).toBe('s');
  });

  test('keeps earlier removals', () => {
    const out = dropFromSelection(
      { random: ['a'], targeted: [], removed: [{ id: 'z', repo: 'o/r', why: 'x' }] },
      [{ id: 'a', repo: 'o/r', why: 'y' }],
    );
    expect(out.removed.map((r) => r.id)).toEqual(['z', 'a']);
  });
});

describe('prune', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crashdummy-prune-'));
    for (const id of ['keep', 'drop']) {
      mkdirSync(join(base, 'cases', id), { recursive: true });
      writeFileSync(join(base, 'cases', id, 'after.test.ts'), 'x');
      writeFileSync(
        join(base, 'cases', id, 'meta.json'),
        JSON.stringify({
          repo: `o/${id}`,
          commit: 'a'.repeat(40),
          license: 'MIT',
          copyright: `Copyright (c) 2024 ${id}`,
        }),
      );
    }
    writeFileSync(join(base, 'NOTICE.md'), 'old notice');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const io = (extra = {}) => ({
    audit: async (meta) => (meta.repo === 'o/drop' ? 'licence is not permissive' : null),
    collectLicenses: async () => [
      {
        repo: 'o/keep',
        dir: 'o__keep',
        files: [{ name: 'LICENSE', bytes: Buffer.from('MIT text') }],
      },
    ],
    log: () => {},
    ...extra,
  });

  test('a selection.json that is missing or malformed leaves every case in place', async () => {
    await expect(prune({ root: base }, io())).rejects.toThrow();
    expect(readdirSync(join(base, 'cases')).sort()).toEqual(['drop', 'keep']);

    writeFileSync(join(base, 'selection.json'), '{ not json');
    await expect(prune({ root: base }, io())).rejects.toThrow();
    writeFileSync(join(base, 'selection.json'), JSON.stringify({ random: 'a', targeted: [] }));
    await expect(prune({ root: base }, io())).rejects.toThrow(/"random" is not a list/);
    expect(readdirSync(join(base, 'cases')).sort()).toEqual(['drop', 'keep']);
    expect(readFileSync(join(base, 'NOTICE.md'), 'utf8')).toBe('old notice');
  });

  test('a case with an unreadable meta.json, or licences that cannot be read, deletes nothing', async () => {
    writeFileSync(
      join(base, 'selection.json'),
      JSON.stringify({ random: ['keep', 'drop'], targeted: [] }),
    );
    await expect(
      prune(
        { root: base },
        io({
          collectLicenses: async () => {
            throw new Error('cannot read LICENSE');
          },
        }),
      ),
    ).rejects.toThrow('cannot read LICENSE');
    expect(readdirSync(join(base, 'cases')).sort()).toEqual(['drop', 'keep']);

    writeFileSync(join(base, 'cases', 'keep', 'meta.json'), '{ broken');
    await expect(prune({ root: base }, io())).rejects.toThrow();
    expect(readdirSync(join(base, 'cases')).sort()).toEqual(['drop', 'keep']);
  });

  test('removes failing cases, and rewrites the selection, the notice and the licences', async () => {
    writeFileSync(
      join(base, 'selection.json'),
      JSON.stringify({ random: ['keep', 'drop'], targeted: [] }),
    );
    const r = await prune({ root: base }, io());
    expect(r).toMatchObject({ kept: 1, changed: true });
    expect(readdirSync(join(base, 'cases'))).toEqual(['keep']);
    const selection = JSON.parse(readFileSync(join(base, 'selection.json'), 'utf8'));
    expect(selection.random).toEqual(['keep']);
    expect(selection.removed.map((x) => x.id)).toEqual(['drop']);
    const text = readFileSync(join(base, 'NOTICE.md'), 'utf8');
    expect(text).toContain('## o/keep');
    expect(text).not.toContain('o/drop');
    expect(text).toContain('`licenses/o__keep/LICENSE`');
    expect(readFileSync(join(base, 'licenses', 'o__keep', 'LICENSE'), 'utf8')).toBe('MIT text');
  });

  test('a dry run changes nothing', async () => {
    writeFileSync(join(base, 'selection.json'), JSON.stringify({ random: [], targeted: [] }));
    const r = await prune({ root: base, dry: true }, io());
    expect(r.changed).toBe(false);
    expect(readdirSync(join(base, 'cases')).sort()).toEqual(['drop', 'keep']);
  });
});
