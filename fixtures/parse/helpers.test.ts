import { test, expect } from 'vitest';
import { render } from './render';

function expectValid(result: { ok: boolean; errors: string[] }) {
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
}

const expectVisible = (el: unknown) => {
  expect(el).toBeTruthy();
};

function unused() {
  expect(1).toBe(1);
}

function twoLevels() {
  expectValid({ ok: true, errors: [] });
}

test('uses a helper function', () => {
  expectValid(render('a'));
});

test('uses an arrow helper and its own assertion', () => {
  expectVisible(render('b'));
  expect(render('b')).toBe('b');
});

test('calls helper twice', () => {
  expectValid(render('c'));
  expectValid(render('d'));
});

test('helper that calls a helper is followed one level only', () => {
  twoLevels();
});

test('custom assert-style helper', () => {
  checkTotals(render('e'));
});

test('has no assertions at all', () => {
  render('f');
});
