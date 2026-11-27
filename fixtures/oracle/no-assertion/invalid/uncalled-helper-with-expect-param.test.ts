import { it } from 'vitest';
import { run } from './run.js';

// a parameter called `expect` that is not a test's context is still a plain local name
function check(expect: (v: unknown) => void) {
  expect(1);
}

// expect: oracle/no-assertion
it('runs', async () => {
  await run();
});
