import { expect, test, vi } from 'vitest';
import { dispatch } from './dispatch.js';

test('does not dispatch for a channel root', async () => {
  const send = vi.fn();
  const handler = dispatch(send);
  await handler({ root: 'channel' });
  expect(send).not.toHaveBeenCalled();
});
