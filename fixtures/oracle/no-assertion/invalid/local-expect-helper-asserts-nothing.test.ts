import { it } from 'vitest';
import { load } from './load.js';

// written in this file, so it is read, and it checks nothing
function expectLoaded(value: unknown) {
  return value;
}

// expect: oracle/no-assertion
it('loads', async () => {
  expectLoaded(await load());
});
