import { describe, it, test, expect, xit, fit } from 'vitest';

describe.skip('skipped suite', () => {
  it('inherits skip', () => {
    expect(1).toBe(1);
  });
  it.only('own only wins', () => {
    expect(1).toBe(1);
  });
});

describe('mixed', () => {
  it.skip('skipped', () => {
    expect(1).toBe(1);
  });
  it.only('only', () => {
    expect(1).toBe(1);
  });
  it.todo('todo one');
  it.fails('known bug', () => {
    expect(1).toBe(2);
  });
  xit('x skipped', () => {});
  fit('f only', () => {
    expect(1).toBe(1);
  });
  it.skipIf(process.env.CI)('conditional', () => {
    expect(1).toBe(1);
  });
  it('plain', () => {
    expect(1).toBe(1);
  });
});

test.skip('top-level skip', () => {});
test('options skip', { skip: true }, () => {});
test('options not skipped', { skip: false }, () => {});
