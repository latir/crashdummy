import { expect, test } from 'vitest';
import { load } from './load.js';

test('loads', () => {
  load().then((value) => {
    // expect: oracle/swallowed-async
    expect(value).toBe(1);
  });
});
