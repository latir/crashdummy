import { it } from 'vitest';
import { expectNoViolations } from './a11y.js';
import { render } from './render.js';

// a helper imported from another file cannot be read, so its name says what it does
it('has no accessibility violations', async () => {
  const page = await render('/settings');
  await expectNoViolations(page);
});
