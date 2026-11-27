import { expectTypeOf, it } from 'vitest';

it('load resolves to a string', () => {
  expectTypeOf<Promise<string>>().resolves.toBeString();
});
