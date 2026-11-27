import { expectTypeOf, it } from 'vitest';
import { load } from './load.js';

it('loads a result from a path', () => {
  expectTypeOf(load).returns.toEqualTypeOf<{ ok: boolean }>();
});

it('takes the path first', () => {
  expectTypeOf(load).parameter(0).toBeString();
});
