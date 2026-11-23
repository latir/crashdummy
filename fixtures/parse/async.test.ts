import { test, expect } from 'vitest';
import { loadUser, failToLoad } from './users';

test('loads a user', async () => {
  const user = await loadUser(1);
  expect(user.name).toBe('Ada');
});

test('resolves with the user', async () => {
  await expect(loadUser(1)).resolves.toEqual({ id: 1, name: 'Ada' });
});

test('rejects with a message', async () => {
  await expect(failToLoad()).rejects.toThrow('not found');
  await expect(failToLoad()).rejects.toThrow();
  await expect(failToLoad()).rejects.not.toBeNull();
});

test('slow one', async () => {
  expect(await loadUser(2)).toBeTruthy();
}, 20_000);

test('with options', { timeout: 5 * 1000 }, async () => {
  expect(1).toBe(1);
});
