import { expectTypeOf, it } from 'vitest';
import type { Options } from './options.js';

it('keeps the option names', () => {
  // a cast literal is how a type is named here; no runtime value is being compared
  expectTypeOf({} as Options).toHaveProperty('timeout');
});
