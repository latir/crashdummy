import { expectTypeOf, it } from 'vitest';
import { load } from './load.js';

// the call alone says nothing: it needs a matcher after it
// expect: oracle/no-assertion
it('checks the type', () => {
  expectTypeOf(load);
});
