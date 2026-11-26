import { it } from 'vitest';
import { render } from './render.js';

// vitest passes each test its own `expect`, which concurrent tests need
it('renders a heading', async ({ expect }) => {
  expect.assertions(1);
  const out = await render('# hi');
  expect(out).toBe('<h1>hi</h1>');
});
