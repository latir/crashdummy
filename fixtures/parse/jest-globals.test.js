const { sum } = require('./sum');

jest.setTimeout(15000);

describe('sum (jest)', () => {
  test('adds', () => {
    expect(sum(1, 2)).toBe(3);
  });

  it('is falsy for zero', () => {
    expect(sum(0, 0)).toBeFalsy();
  });
});
