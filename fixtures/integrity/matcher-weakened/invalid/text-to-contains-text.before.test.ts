import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('shows', () => {
  expect(page.locator('h1')).toHaveText('Cart');
});
