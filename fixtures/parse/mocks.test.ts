import { test, expect, vi } from 'vitest';
import { fetchUser } from './api';
import { formatName } from './format';

vi.mock('./api');

const onSave = vi.fn();
const spy = vi.spyOn(console, 'log');

test('asserts on a mock function', () => {
  onSave('x');
  expect(onSave).toHaveBeenCalledWith('x');
  expect(onSave.mock.calls[0]).toEqual(['x']);
  expect(spy).not.toHaveBeenCalled();
});

test('asserts on the return of a mock', async () => {
  const result = onSave();
  expect(result).toBeUndefined();
});

test('asserts on an auto-mocked import', async () => {
  const user = await fetchUser(1);
  expect(await fetchUser(1)).toEqual(user);
});

test('asserts on real code', () => {
  expect(formatName('ada')).toBe('Ada');
  expect(vi.mocked(formatName)).toBeDefined();
});
