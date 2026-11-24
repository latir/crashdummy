import assert from 'node:assert/strict';
import { test, expect } from 'vitest';
import { parse } from './math';

test('rejects', () => {
  assert.notStrictEqual(parse('a'), 'bad');
});
