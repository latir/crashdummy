import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const bundle = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test.skipIf(!existsSync(bundle))('built CLI bundle runs', () => {
  const out = execFileSync('node', [bundle], { encoding: 'utf8' });
  expect(out).toContain('coming soon');
});
