import { expect, test, vi } from 'vitest';
import { dispatch } from './dispatch.js';

test('looks up the persona in the workspace', async () => {
  const lookup = vi.fn();
  await dispatch(lookup);
  expect(lookup).toHaveBeenCalledWith(expect.anything(), 'ws_1', 'persona_a');
});
