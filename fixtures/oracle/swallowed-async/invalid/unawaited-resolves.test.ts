import { expect, test } from 'vitest';
import { load } from './load.js';

test('loads', async () => {
  // expect: oracle/swallowed-async
  expect(load()).resolves.toBe(1);
});

test('rejects', () => {
  // expect: oracle/swallowed-async
  expect(load()).rejects.toThrow('nope');
});
