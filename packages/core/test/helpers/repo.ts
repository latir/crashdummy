import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
  });
}

export class TempRepo {
  readonly dir: string;

  constructor(prefix = 'crashdummy-git-') {
    this.dir = mkdtempSync(join(tmpdir(), prefix));
  }

  static init(): TempRepo {
    const repo = new TempRepo();
    git(repo.dir, 'init', '-q', '-b', 'main');
    return repo;
  }

  write(path: string, content: string): this {
    const abs = join(this.dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return this;
  }

  git(...args: string[]): string {
    return git(this.dir, ...args);
  }

  commit(message: string): this {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
