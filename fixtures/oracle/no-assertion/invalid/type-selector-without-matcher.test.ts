import { expectTypeOf, it } from 'vitest';
import { load } from './load.js';

// expect: oracle/no-assertion
it('takes the path first', () => {
  // picks a parameter's type but never checks it
  expectTypeOf(load).parameter(0);
});
