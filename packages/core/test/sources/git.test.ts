import { afterEach, describe, expect, test } from 'vitest';
import { gitSource, resolveBase } from '../../src/sources/git.js';
import { SourceError } from '../../src/sources/errors.js';
import { TempRepo, git } from '../helpers/repo.js';

const repos: TempRepo[] = [];
function repo(): TempRepo {
  const r = TempRepo.init();
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

const BASE_TEST = `import { test, expect } from 'vitest';\ntest('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n`;

async function collect(r: TempRepo, extra: Record<string, unknown> = {}) {
  return gitSource.collect({ cwd: r.dir, ...extra });
}

describe('git source', () => {
  test('modified test: before, after and changed line ranges', async () => {
    const r = repo();
    r.write('src/cart.test.ts', BASE_TEST).commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    const next = BASE_TEST.replace('toBe(2)', 'toBeTruthy()') + `test('more', () => {});\n`;
    r.write('src/cart.test.ts', next).commit('weaken');

    const files = await collect(r);
    expect(files).toEqual([
      {
        path: 'src/cart.test.ts',
        kind: 'modified',
        before: BASE_TEST,
        after: next,
        changedLines: [
          { start: 3, end: 3 },
          { start: 5, end: 5 },
        ],
      },
    ]);
  });

  test('a pure rename (identical content) has no changed lines', async () => {
    const r = repo();
    r.write('old.test.ts', BASE_TEST).commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.git('mv', 'old.test.ts', 'new.spec.ts');
    r.commit('rename');

    expect(await collect(r)).toEqual([
      {
        path: 'new.spec.ts',
        kind: 'renamed',
        previousPath: 'old.test.ts',
        before: BASE_TEST,
        after: BASE_TEST,
        changedLines: [],
      },
    ]);
  });

  test('a clearly added file has no before; a clearly deleted file has no after', async () => {
    const r = repo();
    r.write('gone.test.ts', BASE_TEST).write('keep.txt', 'x').commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.git('rm', '-q', 'gone.test.ts');
    r.write('fresh.test.ts', `test('totally different', () => {\n  // nothing alike\n});\n`).commit(
      'x',
    );

    const files = await collect(r);
    expect(files.find((f) => f.path === 'fresh.test.ts')).toMatchObject({
      kind: 'added',
      changedLines: [{ start: 1, end: 3 }],
    });
    expect(files.find((f) => f.path === 'fresh.test.ts')!.before).toBeUndefined();
    const gone = files.find((f) => f.path === 'gone.test.ts')!;
    expect(gone).toMatchObject({ kind: 'deleted', before: BASE_TEST });
    expect(gone.after).toBeUndefined();
  });

  test('rename with edits keeps previousPath and reads the old text', async () => {
    const r = repo();
    const body =
      Array.from(
        { length: 10 },
        (_, i) => `test('t${i}', () => { expect(${i}).toBe(${i}); });`,
      ).join('\n') + '\n';
    r.write('a.test.ts', body).commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.git('mv', 'a.test.ts', 'b.test.ts');
    const edited = body.replace('t3', 'renamed3');
    r.write('b.test.ts', edited).commit('rename');

    const [file, ...rest] = await collect(r);
    expect(rest).toEqual([]);
    expect(file).toMatchObject({
      path: 'b.test.ts',
      kind: 'renamed',
      previousPath: 'a.test.ts',
      before: body,
      after: edited,
      changedLines: [{ start: 4, end: 4 }],
    });
  });

  test('renaming a test to a non-test path is reported as a deleted test', async () => {
    const r = repo();
    const body = BASE_TEST.repeat(3);
    r.write('cart.test.ts', body).commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.git('mv', 'cart.test.ts', 'cart-notes.ts');
    r.commit('rename away');

    expect(await collect(r)).toEqual([{ path: 'cart.test.ts', kind: 'deleted', before: body }]);
  });

  test('renaming a non-test into a test path is reported as an added test', async () => {
    const r = repo();
    const body = BASE_TEST.repeat(3);
    r.write('cart-notes.ts', body).commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.git('mv', 'cart-notes.ts', 'cart.test.ts');
    r.commit('rename in');

    const [file] = await collect(r);
    expect(file).toMatchObject({ path: 'cart.test.ts', kind: 'added', after: body });
    expect(file!.before).toBeUndefined();
  });

  test('source files are filtered unless scope is all', async () => {
    const r = repo();
    r.write('src/cart.ts', 'export const a = 1;\n')
      .write('src/cart.test.ts', BASE_TEST)
      .commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('src/cart.ts', 'export const a = 2;\n')
      .write('src/cart.test.ts', BASE_TEST + '\n')
      .commit('x');

    expect((await collect(r)).map((f) => f.path)).toEqual(['src/cart.test.ts']);
    expect((await collect(r, { scope: 'all' })).map((f) => f.path)).toEqual([
      'src/cart.test.ts',
      'src/cart.ts',
    ]);
  });

  test('testGlobs override the defaults', async () => {
    const r = repo();
    r.write('a.check.ts', 'x\n').write('a.test.ts', 'x\n').commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('a.check.ts', 'y\n').write('a.test.ts', 'y\n').commit('x');

    const files = await collect(r, { testGlobs: ['**/*.check.ts'] });
    expect(files.map((f) => f.path)).toEqual(['a.check.ts']);
  });

  test('diffs against the merge-base, so later commits on the base branch are ignored', async () => {
    const r = repo();
    r.write('a.test.ts', 'one\n').commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('b.test.ts', 'b\n').commit('feature work');
    r.git('checkout', '-q', 'main');
    r.write('c.test.ts', 'c\n').write('a.test.ts', 'two\n').commit('main moves on');
    r.git('checkout', '-q', 'feat');

    expect((await collect(r)).map((f) => f.path)).toEqual(['b.test.ts']);
  });

  test('--base overrides the default', async () => {
    const r = repo();
    r.write('a.test.ts', '1\n').commit('c1');
    r.write('a.test.ts', '2\n').commit('c2');
    r.write('a.test.ts', '3\n').commit('c3');

    const [file] = await collect(r, { base: 'HEAD~2' });
    expect(file).toMatchObject({ path: 'a.test.ts', before: '1\n', after: '3\n' });
  });

  test('default base is the merge-base with origin/HEAD', async () => {
    const origin = repo();
    origin.write('a.test.ts', 'one\n').commit('base');
    const clone = new TempRepo('crashdummy-clone-');
    repos.push(clone);
    git(clone.dir, 'clone', '-q', origin.dir, '.');
    clone.git('checkout', '-q', '-b', 'feat');
    clone.write('b.test.ts', 'b\n').commit('feature');
    // origin advances after the branch point
    origin.write('c.test.ts', 'c\n').commit('later');
    clone.git('fetch', '-q', 'origin');

    expect(await resolveBase(clone.dir)).toBe(origin.git('rev-parse', 'main~1').trim());
    expect((await collect(clone)).map((f) => f.path)).toEqual(['b.test.ts']);
  });

  test('falls back to a local main branch when there is no remote', async () => {
    const r = repo();
    r.write('a.test.ts', 'one\n').commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('a.test.ts', 'two\n').commit('x');
    expect((await collect(r)).map((f) => f.path)).toEqual(['a.test.ts']);
  });

  test('handles spaces and non-ASCII in paths', async () => {
    const r = repo();
    r.write('keep.test.ts', 'k\n').commit('base');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('sp ace/ünï.test.ts', 'hello\n').write('quo"te.test.ts', 'q\n').commit('x');

    const files = await collect(r);
    expect(files.map((f) => f.path).sort()).toEqual(['quo"te.test.ts', 'sp ace/ünï.test.ts']);
    expect(files.every((f) => typeof f.after === 'string')).toBe(true);
  });

  test('no changes gives an empty list', async () => {
    const r = repo();
    r.write('a.test.ts', 'one\n').commit('base');
    expect(await collect(r)).toEqual([]);
  });

  test('uncommitted changes are not included', async () => {
    const r = repo();
    r.write('a.test.ts', 'one\n').commit('base');
    r.write('a.test.ts', 'dirty\n');
    expect(await collect(r)).toEqual([]);
  });

  test('errors are clear', async () => {
    const r = repo();
    r.write('a.test.ts', 'one\n').commit('base');
    r.git('branch', '-m', 'trunk');
    await expect(collect(r)).rejects.toThrow(/Pass --base/);
    await expect(collect(r, { base: 'nope' })).rejects.toBeInstanceOf(SourceError);
  });

  test('detect finds a repo from a subdirectory', async () => {
    const r = repo();
    r.write('sub/dir/x.txt', 'x\n').commit('base');
    expect(await gitSource.detect(`${r.dir}/sub/dir`)).toBe(true);
    const plain = new TempRepo('crashdummy-plain-');
    repos.push(plain);
    expect(await gitSource.detect(plain.dir)).toBe(false);
  });
});
