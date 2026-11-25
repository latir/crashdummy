import { expect, test, vi } from 'vitest';
import { notify } from './notify.js';

test('notifies', () => {
  const send = vi.fn();
  notify(send);
  expect(send).toHaveBeenCalledWith('hello');
});
