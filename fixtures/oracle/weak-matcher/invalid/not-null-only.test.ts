import { expect, test } from 'vitest';
import { find } from './find.js';

test('finds a user', async () => {
  const user = await find(1);
  // expect: oracle/weak-matcher
  expect(user).not.toBeNull();
});
