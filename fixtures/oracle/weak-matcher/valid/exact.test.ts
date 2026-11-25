import { expect, test } from 'vitest';
import { find } from './find.js';

test('finds a user', async () => {
  expect(await find(1)).toEqual({ id: 1, name: 'Ada' });
});
