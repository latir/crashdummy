import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paths } from './paths.js';

test('lists the match page', () => {
  const list = paths();
  assert.ok(list.includes('/match/1'));
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.ok(list.every((p) => p.startsWith('/')));
});

test('reports success', () => {
  const result = paths();
  assert(result.success);
});
