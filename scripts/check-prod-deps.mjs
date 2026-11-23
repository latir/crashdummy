// Fails if the published CLI's production dependency count exceeds the budget.
// The CLI bundles @crashdummy/core, so core's runtime deps must also be listed in the CLI.
import { readFileSync } from 'node:fs';

const MAX = 5;
const pkgs = ['packages/cli/package.json', 'packages/core/package.json'];
let failed = false;
for (const file of pkgs) {
  const deps = Object.keys(JSON.parse(readFileSync(file, 'utf8')).dependencies ?? {});
  const ok = deps.length <= MAX;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${deps.length}/${MAX} production dependencies`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
