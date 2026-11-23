import { expect, test } from 'vitest';
import { name } from '../src/index.js';

test('core package exports its name', () => {
  expect(name).toBe('@crashdummy/core');
});
