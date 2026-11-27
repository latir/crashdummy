import { expect, test } from 'vitest';
import { render } from './render';

test('renders the heading', () => {
  const html = render();
  expect(html).toMatch(/<h1[^>]*>/);
});
