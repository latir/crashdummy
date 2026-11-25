import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const bundle = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// The bundle is what users run: stdout, stderr and the exit code have to survive bundling.
test.skipIf(!existsSync(bundle))('built CLI bundle runs and sets the exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crashdummy-bundle-'));
  try {
    writeFileSync(join(dir, 'a.test.ts'), `import { test } from 'vitest';\ntest('x', () => {});\n`);
    const fail = spawnSync('node', [bundle, '--files', 'a.test.ts', '--format', 'agent'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain('crashdummy: FAIL (1 file)');

    const bad = spawnSync('node', [bundle, 'explain', 'nope'], { cwd: dir, encoding: 'utf8' });
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain('unknown rule');

    const help = spawnSync('node', [bundle, '--help'], { cwd: dir, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
