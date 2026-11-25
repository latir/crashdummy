import { expect, test, vi } from 'vitest';
import * as api from './api.js';
import { greet } from './greet.js';

vi.mock('./api.js');

test('greets the user', async () => {
  vi.mocked(api.getUser).mockResolvedValue({ id: 1, name: 'Ada' });
  expect(await greet(1)).toBe('Hello, Ada');
});

test('a different value comes back', () => {
  const price = vi.fn().mockReturnValue(42);
  expect(price() + 1).toBe(43);
});
