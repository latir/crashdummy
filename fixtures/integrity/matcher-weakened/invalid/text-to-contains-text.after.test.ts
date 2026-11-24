import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

// expect: integrity/matcher-weakened
test('shows', () => {
  expect(page.locator('h1')).toContainText('Cart');
});
