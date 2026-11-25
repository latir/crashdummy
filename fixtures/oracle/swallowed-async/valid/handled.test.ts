import { expect, test } from 'vitest';
import { load } from './load.js';

test('awaited', async () => {
  await expect(load()).resolves.toBe(1);
});

test('returned', () => {
  return expect(load()).rejects.toThrow('nope');
});

test('arrow body', () => expect(load()).resolves.toBe(1));

test('collected', async () => {
  await Promise.all([expect(load()).resolves.toBe(1), expect(load()).resolves.toBe(1)]);
});

test('then is returned', () => {
  return load().then((value) => {
    expect(value).toBe(1);
  });
});

test('then is awaited', async () => {
  await load().then((value) => {
    expect(value).toBe(1);
  });
});
