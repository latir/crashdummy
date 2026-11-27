import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.js';

test('loads the writer', () => {
  const writer = load();
  // expect: oracle/weak-matcher
  assert.ok(writer);
});
