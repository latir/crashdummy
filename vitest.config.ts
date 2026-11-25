import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'corpus/tools/**/*.test.mjs',
    ],
    // fixtures hold intentionally weak tests; they are data, never run
    exclude: ['**/node_modules/**', 'fixtures/**', 'corpus/cases/**', 'corpus/.pool/**'],
  },
});
