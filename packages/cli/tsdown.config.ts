import { defineConfig } from 'tsdown';

// One bundled ESM file. @crashdummy/core is inlined (it is a devDependency),
// oxc-parser stays external because it is a native module.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node20',
  clean: true,
  fixedExtension: false,
  banner: '#!/usr/bin/env node',
  deps: { alwaysBundle: ['@crashdummy/core'], neverBundle: ['oxc-parser'] },
});
