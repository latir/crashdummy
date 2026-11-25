import { expect, test } from '@jest/globals';
import { load } from './load.js';

// expect: oracle/swallowed-async
test('loads', async (done) => {
  expect(await load()).toBe(1);
  done();
});
