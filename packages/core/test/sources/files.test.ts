import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { filesSource, parseFileList, readFileListFromStream } from '../../src/sources/files.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crashdummy-files-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.test.ts'), 'a\n');
  writeFileSync(join(dir, 'src/b.spec.ts'), 'b\n');
  writeFileSync(join(dir, 'src/c.ts'), 'c\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('files source', () => {
  test('existing test files are added with their text and no before', async () => {
    const files = await filesSource.collect({
      cwd: dir,
      files: ['src/a.test.ts', 'src/b.spec.ts'],
    });
    expect(files).toEqual([
      { path: 'src/a.test.ts', kind: 'added', after: 'a\n' },
      { path: 'src/b.spec.ts', kind: 'added', after: 'b\n' },
    ]);
  });

  test('absolute paths become relative posix paths', async () => {
    const files = await filesSource.collect({ cwd: dir, files: [join(dir, 'src/a.test.ts')] });
    expect(files.map((f) => f.path)).toEqual(['src/a.test.ts']);
  });

  test('missing files are deleted', async () => {
    const files = await filesSource.collect({ cwd: dir, files: ['src/gone.test.ts'] });
    expect(files).toEqual([{ path: 'src/gone.test.ts', kind: 'deleted' }]);
  });

  test('non-test files are skipped unless scope is all; duplicates collapse', async () => {
    const list = ['src/c.ts', 'src/a.test.ts', './src/a.test.ts'];
    expect((await filesSource.collect({ cwd: dir, files: list })).map((f) => f.path)).toEqual([
      'src/a.test.ts',
    ]);
    expect(
      (await filesSource.collect({ cwd: dir, files: list, scope: 'all' })).map((f) => f.path),
    ).toEqual(['src/c.ts', 'src/a.test.ts']);
  });

  test('testGlobs override the defaults', async () => {
    const files = await filesSource.collect({
      cwd: dir,
      files: ['src/c.ts'],
      testGlobs: ['src/c.ts'],
    });
    expect(files.map((f) => f.path)).toEqual(['src/c.ts']);
  });

  test('directories are ignored', async () => {
    expect(await filesSource.collect({ cwd: dir, files: ['src'], scope: 'all' })).toEqual([]);
  });

  test('detect is true only when a file list is given', async () => {
    expect(await filesSource.detect(dir, { files: ['x'] })).toBe(true);
    expect(await filesSource.detect(dir, { files: [] })).toBe(false);
    expect(await filesSource.detect(dir)).toBe(false);
  });
});

describe('file list parsing', () => {
  test('newline separated, blank lines and CRLF ignored', () => {
    expect(parseFileList('a.test.ts\r\n\n  b.test.ts  \n')).toEqual(['a.test.ts', 'b.test.ts']);
  });

  test('NUL separated', () => {
    expect(parseFileList('a b.test.ts\0c.test.ts\0')).toEqual(['a b.test.ts', 'c.test.ts']);
  });

  test('reads from a stream', async () => {
    const stream = Readable.from([Buffer.from('a.test.ts\nb.te'), Buffer.from('st.ts\n')]);
    expect(await readFileListFromStream(stream)).toEqual(['a.test.ts', 'b.test.ts']);
  });
});
