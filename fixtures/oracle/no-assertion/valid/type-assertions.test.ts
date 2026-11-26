import { expectTypeOf, it } from 'vitest';
import type { Options } from './options.js';

it('keeps the option names', () => {
  expectTypeOf<Options>().toHaveProperty('timeout');
  expectTypeOf<Options['retries']>().toEqualTypeOf<number>();
});
