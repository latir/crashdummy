import { it, test } from 'vitest';
import { load } from './load.js';

// a named function used as the test body gets vitest's context, so its `expect` is the framework's
function body({ expect }) {
  expect(load()).toBe(1);
}
test('loads one (declaration)', body);

const arrowBody = ({ expect }) => {
  expect(load()).toBe(2);
};
it('loads two (arrow)', arrowBody);

// declared after the test that uses it
it('loads three (hoisted)', later);
function later({ expect }) {
  expect(load()).toBe(3);
}
