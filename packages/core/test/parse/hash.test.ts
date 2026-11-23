import { describe, expect, test } from 'vitest';
import { hashNode, hashText } from '../../src/parse/index.js';
import { summarize } from './helpers.js';

const body = (source: string) => summarize('a.test.ts', source).tests.map((t) => t.bodyHash);

describe('bodyHash', () => {
  test('identical bodies hash the same, wherever they are', () => {
    const [a, b] = body(`
      test('one', () => { expect(add(1, 2)).toBe(3); });
      describe('x', () => { test('two', () => { expect(add(1, 2)).toBe(3); }); });
    `);
    expect(a).toBe(b);
  });

  test('ignores formatting, comments, positions and type annotations', () => {
    const [a, b] = body(`
      test('a', () => { expect(add(1, 2)).toBe(3); });
      test('b', () => {
        // a comment
        expect( add(1,
          2) ).toBe(3 as number);
      });
    `);
    expect(a).toBe(b);
  });

  test('a different literal, identifier or matcher changes it', () => {
    const hashes = body(`
      test('a', () => { expect(add(1, 2)).toBe(3); });
      test('b', () => { expect(add(1, 2)).toBe(4); });
      test('c', () => { expect(sub(1, 2)).toBe(3); });
      test('d', () => { expect(add(1, 2)).toEqual(3); });
    `);
    expect(new Set(hashes).size).toBe(4);
  });

  test('the test name is not part of the hash, so a rename keeps it', () => {
    const [a, b] = body(`
      test('old name', () => { expect(1).toBe(1); });
      test('new name', () => { expect(1).toBe(1); });
    `);
    expect(a).toBe(b);
  });

  test('is 12 hex characters', () => {
    expect(body(`test('a', () => {});`)[0]).toMatch(/^[0-9a-f]{12}$/);
  });

  test('hashNode(undefined) is stable', () => {
    expect(hashNode(undefined)).toBe(hashNode(undefined));
  });
});

test('hashText', () => {
  expect(hashText('a')).toMatch(/^[0-9a-f]{16}$/);
  expect(hashText('a')).not.toBe(hashText('b'));
});
