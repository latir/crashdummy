import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { run, type Io } from '../src/main.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crashdummy-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (path: string, text: string): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};

async function cli(argv: string[], over: Partial<Io> = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    cwd: dir,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    color: false,
    ...over,
  });
  return { code, out, err };
}

const HEAD = `import { test, expect } from 'vitest';\nimport { f } from './f.js';\n`;
const GOOD = `${HEAD}test('x', () => { expect(f()).toEqual({ a: 1 }); });\n`;
const WEAK = `${HEAD}test('x', () => { expect(f()).toBeTruthy(); });\n`;
const NONE = `${HEAD}test('x', () => { f(); });\n`;

describe('exit codes', () => {
  test('0 pass', async () => {
    write('a.test.ts', GOOD);
    const r = await cli(['--files', 'a.test.ts', '--format', 'agent']);
    expect(r).toMatchObject({ code: 0, out: 'crashdummy: PASS (1 file)\n', err: '' });
  });

  test('1 fail on a gate', async () => {
    write('a.test.ts', NONE);
    expect((await cli(['--files', 'a.test.ts'])).code).toBe(1);
  });

  test('a warning is 0, and 2 with --strict-warn', async () => {
    write('a.test.ts', WEAK);
    expect((await cli(['--files', 'a.test.ts'])).code).toBe(0);
    expect((await cli(['--files', 'a.test.ts', '--strict-warn'])).code).toBe(2);
  });

  test('3 for a tool error, with the reason on stderr and nothing on stdout', async () => {
    const bad = await cli(['--format', 'nope', '--files', 'a.test.ts']);
    expect(bad).toMatchObject({ code: 3, out: '' });
    expect(bad.err).toContain('unknown format "nope"');
  });
});

describe('check', () => {
  test('formats: pretty, agent, json', async () => {
    write('a.test.ts', NONE);
    const pretty = await cli(['--files', 'a.test.ts']);
    expect(pretty.out).toContain('crashdummy FAIL');
    const agent = await cli(['--files', 'a.test.ts', '--format', 'agent']);
    expect(agent.out.split('\n').length).toBeLessThanOrEqual(26);
    const json = JSON.parse((await cli(['--files', 'a.test.ts', '--format', 'json'])).out);
    expect(json).toMatchObject({ version: 1, verdict: 'fail', tiersRun: [0] });
  });

  test('formats that are not built yet say so', async () => {
    const r = await cli(['--format', 'sarif', '--files', 'a.test.ts']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('--format sarif is not available yet');
  });

  test('the file list can come from stdin, and files can follow --files', async () => {
    write('a.test.ts', GOOD);
    write('b.test.ts', NONE);
    async function* list() {
      yield 'a.test.ts\nb.test.ts\n';
    }
    const viaStdin = await cli(['--stdin', '--format', 'json'], { stdin: list() });
    expect(JSON.parse(viaStdin.out).files.map((f: { file: string }) => f.file)).toEqual([
      'a.test.ts',
      'b.test.ts',
    ]);
    const many = await cli(['--files', 'a.test.ts', 'b.test.ts', '--format', 'json']);
    expect(JSON.parse(many.out).files).toHaveLength(2);
  });

  test('non-test files in a list are ignored', async () => {
    write('a.ts', 'export const x = 1;\n');
    const r = await cli(['--files', 'a.ts', '--format', 'json']);
    expect(JSON.parse(r.out).files).toEqual([]);
    expect(r.code).toBe(0);
  });

  test('config: minScore, rules and onParseError are read', async () => {
    write('a.test.ts', WEAK);
    write('.crashdummy/config.json', JSON.stringify({ minScore: 99 }));
    expect((await cli(['--files', 'a.test.ts'])).code).toBe(1);
    write('.crashdummy/config.json', JSON.stringify({ rules: { 'oracle/weak-matcher': 'off' } }));
    expect((await cli(['--files', 'a.test.ts', '--strict-warn'])).code).toBe(0);
    write('bad.test.ts', 'test(');
    write('.crashdummy/config.json', JSON.stringify({ onParseError: 'warn' }));
    expect((await cli(['--files', 'bad.test.ts', '--strict-warn'])).code).toBe(2);
    write('.crashdummy/config.json', JSON.stringify({ onParseError: 'fail' }));
    expect((await cli(['--files', 'bad.test.ts'])).code).toBe(1);
  });

  test('config is also read from package.json', async () => {
    write('a.test.ts', WEAK);
    write('package.json', JSON.stringify({ crashdummy: { minScore: 99 } }));
    expect((await cli(['--files', 'a.test.ts'])).code).toBe(1);
  });

  test('a bad config is a tool error that names the key', async () => {
    write('a.test.ts', GOOD);
    write('.crashdummy/config.json', JSON.stringify({ minScor: 1 }));
    const r = await cli(['--files', 'a.test.ts']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('unknown config key "minScor"');
  });

  test('a bad matcher override is a tool error', async () => {
    write('a.test.ts', GOOD);
    write('.crashdummy/config.json', JSON.stringify({ matchers: { toX: { strength: 9 } } }));
    expect((await cli(['--files', 'a.test.ts'])).code).toBe(3);
  });

  test('outside a git repository, with no files, it explains what to do', async () => {
    const r = await cli([]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('not a git repository');
  });

  test('git: checks the tests changed since the base', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd: dir });
    git('init', '-q', '-b', 'main');
    write('a.test.ts', GOOD);
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    write('a.test.ts', WEAK);
    git('commit', '-q', '-am', 'weaken');
    const r = await cli(['--base', 'HEAD~1', '--format', 'agent']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('crashdummy: FAIL');
    expect(r.out).toContain('integrity');
  });
});

describe('explain', () => {
  test('a rule: principle, evidence, example', async () => {
    const r = await cli(['explain', 'oracle/no-assertion']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Why:');
    expect(r.out).toContain('Instead of:');
  });

  test('an unknown rule lists the known ones', async () => {
    const r = await cli(['explain', 'oracle/nope']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('oracle/no-assertion');
  });

  test('without a rule, it says what to pass', async () => {
    expect((await cli(['explain'])).err).toContain('explain needs a rule');
  });

  test('matchers: lists the unknown ones with a snippet', async () => {
    write('a.test.ts', `${HEAD}test('x', () => { expect(f()).toBeWithinRange(1, 2); });\n`);
    const r = await cli(['explain', 'matchers', '--files', 'a.test.ts']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('toBeWithinRange');
    expect(r.out).toContain('"matchers"');
  });
});

describe('help and version', () => {
  test('--help lists the commands and the exit codes', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('crashdummy explain <rule>');
    expect(r.out).toContain('0 pass, 1 fail, 2 warn');
  });

  test('--version prints a version', async () => {
    expect((await cli(['--version'])).out).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('an unknown option is a tool error', async () => {
    const r = await cli(['--nope']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('See --help');
  });
});
