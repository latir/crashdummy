import { expect, test, vi } from 'vitest';
import * as api from './api.js';

vi.mock('./api.js');

test('loads the user', async () => {
  const user = { id: 1, name: 'Ada' };
  vi.mocked(api.getUser).mockResolvedValue(user);
  const result = await api.getUser(1);
  // expect: oracle/tautological-mock
  expect(result).toEqual(user);
});
