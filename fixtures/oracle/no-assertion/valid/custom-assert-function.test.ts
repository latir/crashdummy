// options: {"assertFunctionNames":["expectOk"]}
import { test } from 'vitest';
import { expectOk } from './helpers.js';
import { add } from './add.js';

test('adds numbers', () => {
  expectOk(add(1, 2));
});
